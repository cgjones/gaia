define(
  [
    'rdcommon/log',
    '../a64',
    '../allback',
    '../date',
    '../syncbase',
    '../util',
    'module',
    'require',
    'exports'
  ],
  function(
    $log,
    $a64,
    $allback,
    $date,
    $sync,
    $util,
    $module,
    require,
    exports
  ) {

/**
 * Lazily evaluated modules
 */
var $imaptextparser = null;
var $imapsnippetparser = null;
var $imapbodyfetcher = null;
var $imapchew = null;
var $imapsync = null;

var allbackMaker = $allback.allbackMaker,
    bsearchForInsert = $util.bsearchForInsert,
    bsearchMaybeExists = $util.bsearchMaybeExists,
    cmpHeaderYoungToOld = $util.cmpHeaderYoungToOld,
    DAY_MILLIS = $date.DAY_MILLIS,
    NOW = $date.NOW,
    BEFORE = $date.BEFORE,
    ON_OR_BEFORE = $date.ON_OR_BEFORE,
    SINCE = $date.SINCE,
    TIME_DIR_AT_OR_BEYOND = $date.TIME_DIR_AT_OR_BEYOND,
    TIME_DIR_ADD = $date.TIME_DIR_ADD,
    TIME_DIR_DELTA = $date.TIME_DIR_DELTA,
    makeDaysAgo = $date.makeDaysAgo,
    makeDaysBefore = $date.makeDaysBefore,
    quantizeDate = $date.quantizeDate,
    PASTWARDS = 1, FUTUREWARDS = -1;

/**
 * Compact an array in-place with nulls so that the nulls are removed.  This
 * is done by a scan with an adjustment delta and a final splice to remove
 * the spares.
 */
function compactArray(arr) {
  // this could also be done with a write pointer.
  var delta = 0, len = arr.length;
  for (var i = 0; i < len; i++) {
    var obj = arr[i];
    if (obj === null) {
      delta++;
      continue;
    }
    if (delta)
      arr[i - delta] = obj;
  }
  if (delta)
    arr.splice(len - delta, delta);
  return arr;
}

/**
 * We don't care about deleted messages, it's best that we're not aware of them.
 * However, it's important to keep in mind that this means that EXISTS provides
 * us with an upper bound on the messages in the folder since we are blinding
 * ourselves to deleted messages.
 */
function buildSearch(opts) {
  opts = opts || {};
  opts.not = { deleted: true };
  return opts;
}

/**
 * Number of bytes to fetch from the server for snippets.
 */
var NUMBER_OF_SNIPPET_BYTES = 256;

/**
 * Maximum bytes to request from server in a fetch request (max uint32)
 */
var MAX_FETCH_BYTES = (Math.pow(2, 32) - 1);

/**
 * Folder connections do the actual synchronization logic.  They are associated
 * with one or more `ImapSlice` instances that issue the requests that trigger
 * synchronization.  Storage is handled by `FolderStorage` instances.  All of
 * the connection life-cycle nitty-gritty is handled by the `ImapAccount`.
 *
 * == Progress
 *
 * Our progress break-down is:
 * - [0.0, 0.1]: Getting the IMAP connection.
 * - (0.1, 0.25]: Getting usable SEARCH results.  Bisect back-off does not
 *     update progress.
 * - (0.25, 1.0]: Fetching revised flags, headers, and bodies.  Since this
 *     is primarily a question of network latency, we weight things based
 *     on round-trip requests required with reduced cost for number of packets
 *     required.
 *   - Revised flags: 20 + 1 * number of known headers
 *   - New headers: 20 + 5 * number of new headers
 *   - Bodies: 30 * number of new headers
 *
 * == IDLE
 *
 * We plan to IDLE in folders that we have active slices in.  We are assuming
 * the most basic IDLE implementation where it will tell us when the number
 * of messages increases (EXISTS), or decreases (EXPUNGE and EXISTS), with no
 * notifications when flags change.  (This is my current understanding of how
 * gmail operates from internet searches; we're not quite yet to protocol
 * experimentation yet.)
 *
 * The idea is accordingly that we will use IDLE notifications as a hint that
 * we should do a SEARCH for new messages.  It is that search that will update
 * our accuracy information and only that.
 */
function ImapFolderConn(account, storage, _parentLog) {
  this._account = account;
  this._storage = storage;
  this._LOG = LOGFAB.ImapFolderConn(this, _parentLog, storage.folderId);

  this._conn = null;
  this.box = null;

  this._deathback = null;
}
ImapFolderConn.prototype = {
  /**
   * Acquire a connection and invoke the callback once we have it and we have
   * entered the folder.  This method should only be called when running
   * inside `runMutexed`.
   *
   * @args[
   *   @param[callback @func[
   *     @args[
   *       @param[folderConn ImapFolderConn]
   *       @param[storage FolderStorage]
   *     ]
   *   ]]
   *   @param[deathback Function]{
   *     Invoked if the connection dies.
   *   }
   *   @param[label String]{
   *     A debugging label to name the purpose of the connection.
   *   }
   *   @param[dieOnConnectFailure #:optional Boolean]{
   *     See `ImapAccount.__folderDemandsConnection`.
   *   }
   * ]
   */
  acquireConn: function(callback, deathback, label, dieOnConnectFailure) {
    var self = this;
    this._deathback = deathback;
    this._account.__folderDemandsConnection(
      this._storage.folderId, label,
      function gotconn(conn) {
        self._conn = conn;
        // Now we have a connection, but it's not in the folder.
        // (If we were doing fancier sync like QRESYNC, we would not enter
        // in such a blase fashion.)
        self._conn.selectMailbox(self._storage.folderMeta.path,
                           function openedBox(err, box) {
            if (err) {
              console.error('Problem entering folder',
                            self._storage.folderMeta.path);
              self._conn = null;
              // hand the connection back, noting a resource problem
              self._account.__folderDoneWithConnection(
                self._conn, false, true);
              if (self._deathback) {
                var deathback = self._deathback;
                self.clearErrorHandler();
                deathback();
              }
              return;
            }
            self.box = box;
            callback(self, self._storage);
          });
      },
      function deadconn() {
        self._conn = null;
        if (self._deathback) {
          var deathback = self._deathback;
          self.clearErrorHandler();
          deathback();
        }
      },
      dieOnConnectFailure);
  },

  relinquishConn: function() {
    if (!this._conn)
      return;

    this.clearErrorHandler();
    this._account.__folderDoneWithConnection(this._conn, true, false);
    this._conn = null;
  },

  /**
   * If no connection, acquires one and also sets up
   * deathback if connection is lost.
   *
   * See `acquireConn` for argument docs.
   */
  withConnection: function (callback, deathback, label, dieOnConnectFailure) {
    if (!this._conn) {
      this.acquireConn(function () {
        this.withConnection(callback, deathback, label);
      }.bind(this), deathback, label, dieOnConnectFailure);
      return;
    }

    this._deathback = deathback;
    callback(this);
  },

  /**
   * Resets error handling that may be triggered during
   * loss of connection.
   */
  clearErrorHandler: function () {
    this._deathback = null;
  },

  reselectBox: function(callback) {
    this._conn.selectMailbox(this._storage.folderMeta.path, callback);
  },

  /**
   * Perform a SEARCH for the purposes of folder synchronization.  In the event
   * we are unable to reach the server (we are offline, the server is down,
   * nework troubles), the `abortedCallback` will be invoked.  Note that it can
   * take many seconds for us to conclusively fail to reach the server.
   *
   * Track an isRetry flag to ensure we don't fall into an infinite retry loop.
   */
  _timelySyncSearch: function(searchOptions, searchedCallback,
                              abortedCallback, progressCallback, isRetry) {
    var gotSearchResponse = false;

    // If we don't have a connection, get one, then re-call.
    if (!this._conn) {
      // XXX the abortedCallback should really only be used for the duration
      // of this request, but it will end up being used for the entire duration
      // our folder holds on to the connection.  This is not a great idea as
      // long as we are leaving the IMAP connection idling in the folder (which
      // causes us to not release the connection back to the account).  We
      // should tie this to the mutex or something else transactional.
      this.acquireConn(
        this._timelySyncSearch.bind(this,
                                    searchOptions, searchedCallback,
                                    abortedCallback, progressCallback,
                                    /* isRetry: */ isRetry),
        abortedCallback, 'sync', true);
      return;
    }
    // We do have a connection. Hopefully the connection is still
    // valid and functional. However, since this connection may have
    // been hanging around a while, sending data now might trigger a
    // connection reset notification. In other words, if the
    // connection has gone stale, we want to grab a new connection and
    // retry before aborting.
    else {
      if (!isRetry) {
        var origAbortedCallback = abortedCallback;
        abortedCallback = (function() {
          // Here, we've acquired an already-connected socket. If we
          // were already connected, but failed to receive a response
          // from the server, this socket is effectively dead. In that
          // case, retry the SEARCH once again with a fresh connection,
          // if we haven't already retried the request.
          if (!gotSearchResponse) {
            console.warn('Broken connection for SEARCH. Retrying.');
            this._timelySyncSearch(searchOptions, searchedCallback,
                                   origAbortedCallback, progressCallback,
                                   /* isRetry: */ true);
          }
          // Otherwise, we received an error from this._conn.search
          // below (i.e. there was a legitimate server problem), or we
          // already retried, so we should actually give up.
          else {
            origAbortedCallback();
          }
        }.bind(this));
      }
      this._deathback = abortedCallback;
    }

    // Having a connection is 10% of the battle
    if (progressCallback)
      progressCallback(0.1);

    // Gmail IMAP servers cache search results until your connection
    // gets notified of new messages via an unsolicited server
    // response. Sending a command like NOOP is required to flush the
    // cache and force SEARCH to return new messages that have just
    // been received. Other IMAP servers don't need this as far as we know.
    // See <https://bugzilla.mozilla.org/show_bug.cgi?id=933079>.
    if (this._account.isGmail) {
      this._conn.exec('NOOP');
    }

    this._conn.search(searchOptions, { byUid: true }, function(err, uids) {
        gotSearchResponse = true;
        if (err) {
          console.error('Search error on', searchOptions, 'err:', err);
          abortedCallback();
          return;
        }
        searchedCallback(uids);
      });
  },

  syncDateRange: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(['imap/protocol/sync'], function(_sync) {
      $imapsync = _sync;
      (self.syncDateRange = self._lazySyncDateRange).apply(self, args);
    });
  },

  /**
   * Perform a search to find all the messages in the given date range.
   * Meanwhile, load the set of messages from storage.  Infer deletion of the
   * messages we already know about that should exist in the search results but
   * do not.  Retrieve information on the messages we don't know anything about
   * and update the metadata on the messages we do know about.
   *
   * An alternate way to accomplish the new/modified/deleted detection for a
   * range might be to do a search over the UID range of new-to-us UIDs and
   * then perform retrieval on what we get back.  We would do a flag fetch for
   * all the UIDs we already know about and use that to both get updated
   * flags and infer deletions from UIDs that don't report back.  Except that
   * might not work because the standard doesn't seem to say that if we
   * specify gibberish UIDs that it should keep going for the UIDs that are
   * not gibberish.  Also, it's not clear what the performance impact of the
   * additional search constraint might be on server performance.  (Of course,
   * if the server does not have an index on internaldate, these queries are
   * going to be very expensive and the UID limitation would probably be a
   * mercy to the server.)
   *
   * @args[
   *   @param[startTS @oneof[null DateMS]]{
   *     If non-null, inclusive "SINCE" constraint to use, otherwise the
   *     constraint is omitted.
   *   }
   *   @param[endTS @oneof[null DateMS]]{
   *     If non-null, exclusive "BEFORE" constraint to use, otherwise the
   *     constraint is omitted.
   *   }
   * ]
   */
  _lazySyncDateRange: function(startTS, endTS, accuracyStamp,
                          doneCallback, progressCallback) {
    if (startTS && endTS && SINCE(startTS, endTS)) {
      this._LOG.illegalSync(startTS, endTS);
      doneCallback('invariant');
      return;
    }

console.log("syncDateRange:", startTS, endTS);
    var searchOptions = buildSearch(), self = this,
      storage = self._storage;
    var useBisectLimit = $sync.BISECT_DATE_AT_N_MESSAGES;
    if (startTS) {
      searchOptions.since = new Date(startTS);
    }
    if (endTS) {
      searchOptions.before = new Date(endTS);
    }

    var callbacks = allbackMaker(
      ['search', 'db'],
      function syncDateRangeLogic(results) {
        var serverUIDs = results.search, headers = results.db,
            knownUIDs = [], uid, numDeleted = 0;

        // BrowserBox returns an integer modseq, but it's opaque and
        // we already deal with strings, so cast it here.
        var modseq = '';
        if (self.box.highestModseq) {
          modseq = self.box.highestModseq + '';
        }
console.log('SERVER UIDS', serverUIDs.length, useBisectLimit);
        if (serverUIDs.length > useBisectLimit) {
          var effEndTS = endTS ||
                         quantizeDate(NOW() + DAY_MILLIS + self._account.tzOffset),
              curDaysDelta = Math.round((effEndTS - startTS) / DAY_MILLIS);
          // We are searching more than one day, we can shrink our search.

console.log('BISECT CASE', serverUIDs.length, 'curDaysDelta', curDaysDelta);
          if (curDaysDelta > 1) {
            // mark the bisection abort...
            self._LOG.syncDateRange_end(null, null, null, startTS, endTS,
                                        null, null);
            var bisectInfo = {
              oldStartTS: startTS,
              oldEndTS: endTS,
              numHeaders: serverUIDs.length,
              curDaysDelta: curDaysDelta,
              newStartTS: startTS,
              newEndTS: endTS,
            };
            // If we were being used for a refresh, they may want us to stop
            // and change their sync strategy.
            if (doneCallback('bisect', bisectInfo, null) === 'abort') {
              self.clearErrorHandler();
              doneCallback('bisect-aborted', null);
              return null;
            }
            return self.syncDateRange(
              bisectInfo.newStartTS, bisectInfo.newEndTS, accuracyStamp,
              doneCallback, progressCallback);
          }
        }

        if (progressCallback)
          progressCallback(0.25);

        // -- infer deletion, flag to distinguish known messages
        // rather than splicing lists and causing shifts, we null out values.
        for (var iMsg = 0; iMsg < headers.length; iMsg++) {
          var header = headers[iMsg];
          var idxUid = serverUIDs.indexOf(header.srvid);
          // deleted!
          if (idxUid === -1) {
            storage.deleteMessageHeaderAndBodyUsingHeader(header);
            numDeleted++;
            headers[iMsg] = null;
            continue;
          }
          // null out the UID so the non-null values in the search are the
          // new messages to us.
          serverUIDs[idxUid] = null;
          // but save the UID so we can do a flag-check.
          knownUIDs.push(header.srvid);
        }

        var newUIDs = compactArray(serverUIDs); // (re-labeling, same array)
        if (numDeleted)
          compactArray(headers);

        var uidSync = new $imapsync.Sync({
          connection: self._conn,
          storage: self._storage,
          newUIDs: newUIDs,
          knownUIDs: knownUIDs,
          knownHeaders: headers
        });

        uidSync.onprogress = progressCallback;

        uidSync.oncomplete = function(newCount, knownCount) {
            self._LOG.syncDateRange_end(newCount, knownCount, numDeleted,
                                        startTS, endTS, null, null);

            self._storage.markSyncRange(startTS, endTS, modseq,
                                        accuracyStamp);
            if (completed)
              return;

            completed = true;
            self.clearErrorHandler();
            doneCallback(null, null, newCount + knownCount,
                         skewedStartTS, skewedEndTS);
        };

        return;
      });

    // - Adjust DB time range for server skew on INTERNALDATE
    // See https://github.com/mozilla-b2g/gaia-email-libs-and-more/issues/12
    // for more in-depth details.  The nutshell is that the server will secretly
    // apply a timezone to the question we ask it and will not actually tell us
    // dates lined up with UTC.  Accordingly, we don't want our DB query to
    // be lined up with UTC but instead the time zone.
    //
    // So if our timezone offset is UTC-4, that means that we will actually be
    // getting results in that timezone, whose midnight is actually 4am UTC.
    // In other words, we care about the time in UTC-0, so we subtract the
    // offset.
    var skewedStartTS = startTS - this._account.tzOffset,
        skewedEndTS = endTS ? endTS - this._account.tzOffset : null,
        completed = false;
    console.log('Skewed DB lookup. Start: ',
                skewedStartTS, new Date(skewedStartTS).toUTCString(),
                'End: ', skewedEndTS,
                skewedEndTS ? new Date(skewedEndTS).toUTCString() : null);
    this._LOG.syncDateRange_begin(null, null, null, startTS, endTS,
                                  skewedStartTS, skewedEndTS);

    this._timelySyncSearch(
      searchOptions, callbacks.search,
      function abortedSearch() {
        if (completed)
          return;
        completed = true;
        this._LOG.syncDateRange_end(0, 0, 0, startTS, endTS, null, null);
        doneCallback('aborted');
      }.bind(this),
      progressCallback,
      /* isRetry: */ false);
    this._storage.getAllMessagesInImapDateRange(skewedStartTS, skewedEndTS,
                                                callbacks.db);
  },

  /**
   * Downloads all the body representations for a given message.
   *
   *
   *    folder.downloadBodyReps(
   *      header,
   *      {
   *        // maximum number of bytes to fetch total (across all bodyReps)
   *        maximumBytesToFetch: N
   *      }
   *      callback
   *    );
   *
   */
  downloadBodyReps: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(
      [
        './imapchew',
        './protocol/bodyfetcher',
        './protocol/textparser',
        './protocol/snippetparser'
      ],
      function(
        _imapchew,
        _bodyfetcher,
        _textparser,
        _snippetparser
      ) {

        $imapchew =_imapchew;
        $imapbodyfetcher = _bodyfetcher;
        $imaptextparser = _textparser;
        $imapsnippetparser = _snippetparser;

        (self.downloadBodyReps = self._lazyDownloadBodyReps).apply(self, args);
    });
  },

  /**
   * Initiates a request to download all body reps. If a snippet has not yet
   * been generated this will also generate the snippet...
   */
  _lazyDownloadBodyReps: function(header, options, callback) {
    if (typeof(options) === 'function') {
      callback = options;
      options = null;
    }

    options = options || {};

    var self = this;

    var gotBody = function gotBody(bodyInfo) {
      // target for snippet generation
      var bodyRepIdx = $imapchew.selectSnippetBodyRep(header, bodyInfo);

      // assume user always wants entire email unless option is given...
      var overallMaximumBytes = options.maximumBytesToFetch;

      var bodyParser = $imaptextparser.TextParser;

      // build the list of requests based on downloading required.
      var requests = [];
      bodyInfo.bodyReps.forEach(function(rep, idx) {
        // attempt to be idempotent by only requesting the bytes we need if we
        // actually need them...
        if (rep.isDownloaded)
          return;

        var request = {
          uid: header.srvid,
          partInfo: rep._partInfo,
          bodyRepIndex: idx,
          createSnippet: idx === bodyRepIdx
        };

        // default to the entire remaining email. We use the estimate * largish
        // multiplier so even if the size estimate is wrong we should fetch more
        // then the requested number of bytes which if truncated indicates the
        // end of the bodies content.
        var bytesToFetch = Math.min(rep.sizeEstimate * 5, MAX_FETCH_BYTES);

        if (overallMaximumBytes !== undefined) {
          // when we fetch partial results we need to use the snippet parser.
          bodyParser = $imapsnippetparser.SnippetParser;

          // issued enough downloads
          if (overallMaximumBytes <= 0) {
            return;
          }

          // if our estimate is greater then expected number of bytes
          // request the maximum allowed.
          if (rep.sizeEstimate > overallMaximumBytes) {
            bytesToFetch = overallMaximumBytes;
          }

          // subtract the estimated byte size
          overallMaximumBytes -= rep.sizeEstimate;
        }

        // For a byte-serve request, we need to request at least 1 byte, so
        // request some bytes.  This is a logic simplification that should not
        // need to be used because imapchew.js should declare 0-byte files
        // fully downloaded when their parts are created, but better a wasteful
        // network request than breaking here.
        if (bytesToFetch <= 0)
          bytesToFetch = 64;

        // we may only need a subset of the total number of bytes.
        if (overallMaximumBytes !== undefined || rep.amountDownloaded) {
          // request the remainder
          request.bytes = [
            rep.amountDownloaded,
            bytesToFetch
          ];
        }

        requests.push(request);
      });

      // we may not have any requests bail early if so.
      if (!requests.length) {
        callback(null, bodyInfo); // no requests === success
        return;
      }

      var fetch = new $imapbodyfetcher.BodyFetcher(
        self._conn,
        bodyParser,
        requests
      );

      self._handleBodyFetcher(fetch, header, bodyInfo, function(err) {
        callback(err, bodyInfo);
      });
    };

    this._storage.getMessageBody(header.suid, header.date, gotBody);
  },

  /**
   * Download a snippet and a portion of the bodyRep to go along with it... In
   * all cases we expect the bodyReps to be completely empty as we also will
   * generate the snippet in the case of completely downloading a snippet.
   */
  _downloadSnippet: function(header, callback) {
    var self = this;
    this._storage.getMessageBody(header.suid, header.date, function(body) {
      // attempt to find a rep
      var bodyRepIndex = $imapchew.selectSnippetBodyRep(header, body);

      // no suitable snippet we are done.
      if (bodyRepIndex === -1)
        return callback();

      var rep = body.bodyReps[bodyRepIndex];
      var requests = [{
        uid: header.srvid,
        bodyRepIndex: bodyRepIndex,
        partInfo: rep._partInfo,
        bytes: [0, NUMBER_OF_SNIPPET_BYTES],
        createSnippet: true
      }];

      var fetch = new $imapbodyfetcher.BodyFetcher(
        self._conn,
        $imapsnippetparser.SnippetParser,
        requests
      );

      self._handleBodyFetcher(
        fetch,
        header,
        body,
        callback
      );
    });
  },

  /**
   * Wrapper around common bodyRep updates...
   */
  _handleBodyFetcher: function(fetcher, header, body, callback) {
    var event = {
      changeDetails: {
        bodyReps: []
      }
    };

    var self = this;

    fetcher.onparsed = function(req, resp) {
      $imapchew.updateMessageWithFetch(header, body, req, resp, self._LOG);

      header.bytesToDownloadForBodyDisplay =
        $imapchew.calculateBytesToDownloadForImapBodyDisplay(body);

      // Always update the header so that we can save
      // bytesToDownloadForBodyDisplay, which will tell the UI whether
      // or not we can show the message body right away.
      self._storage.updateMessageHeader(
        header.date,
        header.id,
        false,
        header,
        body
      );

      event.changeDetails.bodyReps.push(req.bodyRepIndex);
    };

    fetcher.onerror = function(e) {
      callback(e);
    };

    fetcher.onend = function() {
      self._storage.updateMessageBody(
        header,
        body,
        {},
        event
      );

      self._storage.runAfterDeferredCalls(callback);
    };
  },

  /**
   * The actual work of downloadBodies, lazily replaces downloadBodies once
   * module deps are loaded.
   */
  _lazyDownloadBodies: function(headers, options, callback) {
    var pending = 1, downloadsNeeded = 0;

    var self = this;
    var anyErr;
    function next(err) {
      if (err && !anyErr)
        anyErr = err;

      if (!--pending) {
        self._storage.runAfterDeferredCalls(function() {
          callback(anyErr, /* number downloaded */ downloadsNeeded - pending);
        });
      }
    }

    for (var i = 0; i < headers.length; i++) {
      // We obviously can't do anything with null header references.
      // To avoid redundant work, we also don't want to do any fetching if we
      // already have a snippet.  This could happen because of the extreme
      // potential for a caller to spam multiple requests at us before we
      // service any of them.  (Callers should only have one or two outstanding
      // jobs of this and do their own suppression tracking, but bugs happen.)
      if (!headers[i] || headers[i].snippet !== null) {
        continue;
      }

      pending++;
      // This isn't absolutely guaranteed to be 100% correct, but is good enough
      // for indicating to the caller that we did some work.
      downloadsNeeded++;
      this.downloadBodyReps(headers[i], options, next);
    }

    // by having one pending item always this handles the case of not having any
    // snippets needing a download and also returning in the next tick of the
    // event loop.
    window.setZeroTimeout(next);
  },

  /**
   * Download snippets or entire bodies for a set of headers.
   */
  downloadBodies: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(
      ['./imapchew', './protocol/bodyfetcher', './protocol/snippetparser'],
      function(
        _imapchew,
        _bodyfetcher,
        _snippetparser
      ) {

        $imapchew =_imapchew;
        $imapbodyfetcher = _bodyfetcher;
        $imapsnippetparser = _snippetparser;

        (self.downloadBodies = self._lazyDownloadBodies).apply(self, args);
    });
  },

  downloadMessageAttachments: function(uid, partInfos, callback, progress) {
    require(['mimeparser'], function(MimeParser) {
      var conn = this._conn;
      var self = this;

      var latch = $allback.latch();
      var anyError = null;
      var bodies = [];

      partInfos.forEach(function(partInfo, index) {
        var partKey = 'body.peek[' + partInfo.part + ']';
        var partDone = latch.defer(partInfo.part);
        conn.listMessages(
          uid,
          [partKey],
          { byUid: true },
          function(err, messages) {
            if (err) {
              anyError = err;
              console.error('attachments:download-error', {
                error: err,
                part: partInfo.part,
                type: partInfo.type
              });
              partDone();
              return;
            }

            // We only receive one message per each listMessages call.
            var msg = messages[0];

            // Find the proper response key of the message. Since this
            // response object is a lightweight wrapper around the
            // response returned from the IRC server and it's possible
            // there are poorly-behaved servers out there, best to err
            // on the side of safety.
            var bodyPart;
            for (var key in msg) {
              if (/body\[/.test(key)) {
                bodyPart = msg[key];
                break;
              }
            }

            if (!bodyPart) {
              console.error('attachments:download-error', {
                error: 'no body part?',
                requestedPart: partKey,
                responseKeys: Object.keys(msg)
              });
              partDone();
              return;
            }

            // TODO: stream attachments, bug 1047032
            var parser = new MimeParser();
            // TODO: escape partInfo.type/encoding
            parser.write('Content-Type: ' + partInfo.type + '\r\n');
            parser.write('Content-Transfer-Encoding: ' + partInfo.encoding + '\r\n');
            parser.write('\r\n');
            parser.write(bodyPart);
            parser.end(); // Parsing is actually synchronous.

            var node = parser.node;

            console.error('imap:built-attachment-part', JSON.stringify({
              contentType: node.contentType.value,
              length: node.content.length
            }));

            bodies[index] = new Blob([node.content], {
              type: node.contentType.value
            });

            partDone();
          });
      });

      latch.then(function(results) {
        callback(anyError, bodies);
      });
    }.bind(this));
  },

  shutdown: function() {
    this._LOG.__die();
  },
};

function ImapFolderSyncer(account, folderStorage, _parentLog) {
  this._account = account;
  this.folderStorage = folderStorage;

  this._LOG = LOGFAB.ImapFolderSyncer(this, _parentLog, folderStorage.folderId);


  this._syncSlice = null;
  /**
   * The timestamp to use for `markSyncRange` for all syncs in this higher
   * level sync.  Accuracy time-info does not need high precision, so this
   * results in fewer accuracy structures and simplifies our decision logic
   * in `sliceOpenMostRecent`.
   */
  this._curSyncAccuracyStamp = null;
  /**
   * @oneof[
   *   @case[1]{
   *     Growing older/into the past.
   *   }
   *   @case[-1]{
   *     Growing into the present/future.
   *   }
   * ]{
   *   Sync growth direction.  Numeric values chosen to be consistent with
   *   slice semantics (which are oriented like they are because the slices
   *   display messages from newest to oldest).
   * }
   */
  this._curSyncDir = 1;
  /**
   * Synchronization is either 'grow' or 'refresh'.  Growth is when we just
   * want to learn about some new messages.  Refresh is when we know we have
   * already synchronized a time region and want to fully update it and so will
   * keep going until we hit our `syncThroughTS` threshold.
   */
  this._curSyncIsGrow = null;
  /**
   * The timestamp that will anchor the next synchronization.
   */
  this._nextSyncAnchorTS = null;
  /**
   * In the event of a bisection, this is the timestamp to fall back to rather
   * than continuing from our
   */
  this._fallbackOriginTS = null;
  /**
   * The farthest timestamp that we should synchronize through.  The value
   * null is potentially meaningful if we are synchronizing FUTUREWARDS.
   */
  this._syncThroughTS = null;
  /**
   * The number of days we are looking into the past in the current sync step.
   */
  this._curSyncDayStep = null;
  /**
   * If non-null, then we must synchronize all the way through the provided date
   * before we begin increasing _curSyncDayStep.  This helps us avoid
   * oscillation where we make the window too large, shrink it, but then find
   * find nothing.  Since we know that there are going to be a lot of messages
   * before we hit this date, it makes sense to keep taking smaller sync steps.
   */
  this._curSyncDoNotGrowBoundary = null;
  /**
   * The callback to invoke when we complete the sync, regardless of success.
   */
  this._curSyncDoneCallback = null;

  this.folderConn = new ImapFolderConn(account, folderStorage, this._LOG);
}
exports.ImapFolderSyncer = ImapFolderSyncer;
ImapFolderSyncer.prototype = {
  /**
   * Although we do have some errbackoff stuff we do, we can always try to
   * synchronize.  The errbackoff is just a question of when we will retry.
   */
  syncable: true,

  /**
   * Can we grow this sync range?  IMAP always lets us do this.
   */
  get canGrowSync() {
    // Some folders, like localdrafts and outbox, cannot be synced
    // because they are local-only.
    return !this.folderStorage.isLocalOnly;
  },

  /**
   * Perform an initial synchronization of a folder from now into the past,
   * starting with the specified step size.
   */
  initialSync: function(slice, initialDays, syncCallback,
                        doneCallback, progressCallback) {
    syncCallback('sync', false /* Ignore Headers */);
    // We want to enter the folder and get the box info so we can know if we
    // should trigger our SYNC_WHOLE_FOLDER_AT_N_MESSAGES logic.
    // _timelySyncSearch is what will get called next either way, and it will
    // just reuse the connection and will correctly update the deathback so
    // that our deathback is no longer active.
    this.folderConn.withConnection(
      function(folderConn, storage) {
        // Flag to sync the whole range if we
        var syncWholeTimeRange = false;
        if (folderConn && folderConn.box &&
            folderConn.box.exists <
              $sync.SYNC_WHOLE_FOLDER_AT_N_MESSAGES) {
          syncWholeTimeRange = true;
        }

        this._startSync(
          slice, PASTWARDS, // sync into the past
          'grow',
          null, // start syncing from the (unconstrained) future
          $sync.OLDEST_SYNC_DATE, // sync no further back than this constant
          null,
          syncWholeTimeRange ? null : initialDays,
          doneCallback, progressCallback);
      }.bind(this),
      function died() {
        doneCallback('aborted');
      },
      'initialSync', true);
  },

  /**
   * Perform a refresh synchronization covering the requested time range.  This
   * may be converted into multiple smaller synchronizations, but the completion
   * notification will only be generated once the entire time span has been
   * synchronized.
   */
  refreshSync: function(slice, dir, startTS, endTS, origStartTS,
                        doneCallback, progressCallback) {
    // timezone compensation happens in the caller
    this._startSync(
      slice, dir,
      'refresh', // this is a refresh, not a grow!
      dir === PASTWARDS ? endTS : startTS,
      dir === PASTWARDS ? startTS : endTS,
      origStartTS,
      /* syncStepDays */ null, doneCallback, progressCallback);
  },

  /**
   * Synchronize into a time period not currently covered.  Growth has an
   * explicit direction and explicit origin timestamp.
   *
   * @args[
   *   @param[slice]
   *   @param[growthDirection[
   *   @param[anchorTS]
   *   @param[syncStepDays]
   *   @param[doneCallback]
   *   @param[progressCallback]
   * ]
   * @return[Boolean]{
   *   Returns false if no sync is necessary.
   * }
   */
  growSync: function(slice, growthDirection, anchorTS, syncStepDays,
                     doneCallback, progressCallback) {
    var syncThroughTS;
    if (growthDirection === PASTWARDS) {
      syncThroughTS = $sync.OLDEST_SYNC_DATE;
    }
    else { // FUTUREWARDS
      syncThroughTS = null;
    }

    this._startSync(slice, growthDirection, 'grow',
                    anchorTS, syncThroughTS, null, syncStepDays,
                    doneCallback, progressCallback);
  },

  _startSync: function ifs__startSync(slice, dir, syncTypeStr,
                                      originTS, syncThroughTS, fallbackOriginTS,
                                      syncStepDays,
                                      doneCallback, progressCallback) {
    var startTS, endTS;
    this._syncSlice = slice;
    this._curSyncAccuracyStamp = NOW();
    this._curSyncDir = dir;
    this._curSyncIsGrow = (syncTypeStr === 'grow');
    this._fallbackOriginTS = fallbackOriginTS;
    if (dir === PASTWARDS) {
      endTS = originTS;
      if (syncStepDays) {
        if (endTS)
          this._nextSyncAnchorTS = startTS = endTS - syncStepDays * DAY_MILLIS;
        else
          this._nextSyncAnchorTS = startTS = makeDaysAgo(syncStepDays,
                                                         this._account.tzOffset);
      }
      else {
        startTS = syncThroughTS;
        this._nextSyncAnchorTS = null;
      }
    }
    else { // FUTUREWARDS
      startTS = originTS;
      if (syncStepDays) {
        this._nextSyncAnchorTS = endTS = startTS + syncStepDays * DAY_MILLIS;
      }
      else {
        endTS = syncThroughTS;
        this._nextSyncAnchorTS = null;
      }
    }
    this._syncThroughTS = syncThroughTS;
    this._curSyncDayStep = syncStepDays;
    this._curSyncDoNotGrowBoundary = null;
    this._curSyncDoneCallback = doneCallback;

    this.folderConn.syncDateRange(startTS, endTS, this._curSyncAccuracyStamp,
                                  this.onSyncCompleted.bind(this),
                                  progressCallback);
  },

  _doneSync: function ifs__doneSync(err) {
    // The desired number of headers is always a rough request value which is
    // intended to be a new thing for each request.  So we don't want extra
    // desire building up, so we set it to what we have every time.
    //
    this._syncSlice.desiredHeaders = this._syncSlice.headers.length;

    // Save our state even if there was an error because we may have accumulated
    // some partial state.  Additionally, don't *actually* complete until the
    // save has hit the disk.  This is beneficial for both tests and cronsync
    // which has been trying to shut us down in a race with this save
    // triggering.
    this._account.__checkpointSyncCompleted(function () {
      if (this._curSyncDoneCallback)
        this._curSyncDoneCallback(err);

      this._syncSlice = null;
      this._curSyncAccuracyStamp = null;
      this._curSyncDir = null;
      this._nextSyncAnchorTS = null;
      this._syncThroughTS = null;
      this._curSyncDayStep = null;
      this._curSyncDoNotGrowBoundary = null;
      this._curSyncDoneCallback = null;
    }.bind(this));
  },

  /**
   * Whatever synchronization we last triggered has now completed; we should
   * either trigger another sync if we still want more data, or close out the
   * current sync.
   *
   * ## Block Flushing
   *
   * We only cause a call to `ImapAccount.__checkpointSyncCompleted` (via a call
   * to `_doneSync`) to happen and cause dirty blocks to be written to disk when
   * we are done with synchronization.  This is because this method declares
   * victory once a non-trivial amount of work has been done.  In the event that
   * the sync is encountering a lot of deleted messages and so keeps loading
   * blocks, the memory burden is limited because we will be emptying those
   * blocks out so actual memory usage (after GC) is commensurate with the
   * number of (still-)existing messages.  And those are what this method uses
   * to determine when it is done.
   *
   * In the cases where we are synchronizing a ton of messages on a single day,
   * we could perform checkpoints during the process, but realistically any
   * device we are operating on should probably have enough memory to deal with
   * these surges, so we're not doing that yet.
   *
   * @args[
   *   @param[err]
   *   @param[bisectInfo]
   *   @param[messagesSeen Number]
   *   @param[effStartTS DateMS]{
   *     Effective start date in UTC after compensating for server tz offset.
   *   }
   *   @param[effEndTS @oneof[DateMS null]]{
   *     Effective end date in UTC after compensating for server tz offset.
   *     If the end date was open-ended, then null is passed instead.
   *   }
   * ]
   */
  onSyncCompleted: function ifs_onSyncCompleted(err, bisectInfo, messagesSeen,
                                                effStartTS, effEndTS) {
    // In the event the time range had to be bisected, update our info so if
    // we need to take another step we do the right thing.
    if (err === 'bisect') {
      var curDaysDelta = bisectInfo.curDaysDelta,
          numHeaders = bisectInfo.numHeaders;

      // If we had a fallback TS because we were synced to the dawn of time,
      // use that and start by just cutting the range in thirds rather than
      // doing a weighted bisection since the distribution might include
      // a number of messages earlier than our fallback startTS.
      if (this._curSyncDir === FUTUREWARDS && this._fallbackOriginTS) {
        this.folderStorage.clearSyncedToDawnOfTime(this._fallbackOriginTS);
        bisectInfo.oldStartTS = this._fallbackOriginTS;
        this._fallbackOriginTS = null;
        var effOldEndTS = bisectInfo.oldEndTS ||
                          quantizeDate(NOW() + DAY_MILLIS +
                                       this._account.tzOffset);
        curDaysDelta = Math.round((effOldEndTS - bisectInfo.oldStartTS) /
                                  DAY_MILLIS);
        numHeaders = $sync.BISECT_DATE_AT_N_MESSAGES * 1.5;
      }
      // Sanity check the time delta; if we grew the bounds to the dawn
      // of time, then our interpolation is useless and it's better for
      // us to crank things way down, even if it's erroneously so.
      else if (curDaysDelta > 1000)
        curDaysDelta = 30;

      // - Interpolate better time bounds.
      // Assume a linear distribution of messages, but overestimated by
      // a factor of two so we undershoot.  Also make sure that we subtract off
      // at least 2 days at a time.  This is to ensure that in the case where
      // endTS is null and we end up using makeDaysAgo that we actually shrink
      // by at least 1 day (because of how rounding works for makeDaysAgo).
      var shrinkScale = $sync.BISECT_DATE_AT_N_MESSAGES /
                          (numHeaders * 2),
          dayStep = Math.max(1,
                             Math.min(curDaysDelta - 2,
                                      Math.ceil(shrinkScale * curDaysDelta)));
      this._curSyncDayStep = dayStep;

      if (this._curSyncDir === PASTWARDS) {
        bisectInfo.newEndTS = bisectInfo.oldEndTS;
        this._nextSyncAnchorTS = bisectInfo.newStartTS =
          makeDaysBefore(bisectInfo.newEndTS, dayStep, this._account.tzOffset);
        this._curSyncDoNotGrowBoundary = bisectInfo.oldStartTS;
      }
      else { // FUTUREWARDS
        bisectInfo.newStartTS = bisectInfo.oldStartTS;
        this._nextSyncAnchorTS = bisectInfo.newEndTS =
          makeDaysBefore(bisectInfo.newStartTS, -dayStep, this._account.tzOffset);
        this._curSyncDoNotGrowBoundary = bisectInfo.oldEndTS;
      }

      // We return now without calling _doneSync because we are not done; the
      // caller (syncDateRange) will re-trigger itself and keep going.
      return;
    }
    else if (err) {
      this._doneSync(err);
      return;
    }

    console.log("Sync Completed!", this._curSyncDayStep, "days",
                messagesSeen, "messages synced");

    // - Slice is dead = we are done
    if (this._syncSlice.isDead) {
      this._doneSync();
      return;
    }

    // If it now appears we know about all the messages in the folder, then we
    // are done syncing and can mark the entire folder as synchronized.  This
    // requires that:
    // - The direction is pastwards. (We check the oldest header, so this
    //   is important.  We don't really need to do a future-wards variant since
    //   we always use pastwards for refreshes and the future-wards variant
    //   really does not need a fast-path since the cost of stepping to 'today'
    //   is much cheaper thana the cost of walking all the way to 1990.)
    // - The number of messages we know about is the same as the number the
    //   server most recently told us are in the folder.
    // - (There are no messages in the folder at all OR)
    // - We have synchronized past the oldest known message header.  (This,
    //   in combination with the fact that we always open from the most recent
    //   set of messages we know about, that we fully synchronize all time
    //   intervals (for now!), and our pastwards-direction for refreshes means
    //   that we can conclude we have synchronized across all messages and
    //   this is a sane conclusion to draw.)
    //
    // NB: If there are any deleted messages, this logic will not save us
    // because we ignored those messages.  This is made less horrible by issuing
    // a time-date that expands as we go further back in time.
    //
    // (I have considered asking to see deleted messages too and ignoring them;
    // that might be suitable.  We could also just be a jerk and force an
    // expunge.)
    var folderMessageCount = this.folderConn && this.folderConn.box &&
                             this.folderConn.box.exists,
        dbCount = this.folderStorage.getKnownMessageCount(),
        syncedThrough =
          ((this._curSyncDir === PASTWARDS) ? effStartTS : effEndTS);
console.log("folder message count", folderMessageCount,
            "dbCount", dbCount,
            "syncedThrough", syncedThrough,
            "oldest known", this.folderStorage.getOldestMessageTimestamp());
    if (this._curSyncDir === PASTWARDS &&
        folderMessageCount === dbCount &&
        (!folderMessageCount ||
         TIME_DIR_AT_OR_BEYOND(this._curSyncDir, syncedThrough,
                               this.folderStorage.getOldestMessageTimestamp()))
       ) {
      // expand the accuracy range to cover everybody
      this.folderStorage.markSyncedToDawnOfTime();
      this._doneSync();
      return;
    }
    // If we've synchronized to the limits of syncing in the given direction,
    // we're done.
    if (!this._nextSyncAnchorTS ||
        TIME_DIR_AT_OR_BEYOND(this._curSyncDir, this._nextSyncAnchorTS,
                              this._syncThroughTS)) {
      this._doneSync();
      return;
    }

    // - Done if this is a grow and we don't want/need any more headers.
    if (this._curSyncIsGrow &&
        this._syncSlice.headers.length >= this._syncSlice.desiredHeaders) {
        // (limited syncs aren't allowed to expand themselves)
      console.log("SYNCDONE Enough headers retrieved.",
                  "have", this._syncSlice.headers.length,
                  "want", this._syncSlice.desiredHeaders,
                  "conn knows about", this.folderConn.box.exists,
                  "sync date", this._curSyncStartTS,
                  "[oldest defined as", $sync.OLDEST_SYNC_DATE, "]");
      this._doneSync();
      return;
    }

    // - Increase our search window size if we aren't finding anything
    // Our goal is that if we are going backwards in time and aren't finding
    // anything, we want to keep expanding our window
    var daysToSearch, lastSyncDaysInPast;
    // If we saw messages, there is no need to increase the window size.  We
    // also should not increase the size if we explicitly shrank the window and
    // left a do-not-expand-until marker.
    if (messagesSeen || (this._curSyncDoNotGrowBoundary !== null &&
         !TIME_DIR_AT_OR_BEYOND(this._curSyncDir, this._nextSyncAnchorTS,
                                this._curSyncDoNotGrowBoundary))) {
      daysToSearch = this._curSyncDayStep;
    }
    else {
      this._curSyncDoNotGrowBoundary = null;
      // This may be a fractional value because of DST
      lastSyncDaysInPast = ((quantizeDate(NOW() + this._account.tzOffset)) -
                           this._nextSyncAnchorTS) / DAY_MILLIS;
      daysToSearch = Math.ceil(this._curSyncDayStep *
                               $sync.TIME_SCALE_FACTOR_ON_NO_MESSAGES);

      // These values used to be more conservative, but the importance of these
      // guards was reduced when we switched to only syncing headers.
      // At current constants (sync=3, scale=2), our doubling in the face of
      // clamping is: 3, 6, 12, 24, 45, ... 90,
      if (lastSyncDaysInPast < 180) {
        if (daysToSearch > 45)
          daysToSearch = 45;
      }
      else if (lastSyncDaysInPast < 365) { // 1 year
        if (daysToSearch > 90)
          daysToSearch = 90;
      }
      else if (lastSyncDaysInPast < 730) { // 2 years
        if (daysToSearch > 120)
          daysToSearch = 120;
      }
      else if (lastSyncDaysInPast < 1825) { // 5 years
        if (daysToSearch > 180)
          daysToSearch = 180;
      }
      else if (lastSyncDaysInPast < 3650) { // 10 years
        if (daysToSearch > 365)
          daysToSearch = 365;
      }
      else if (daysToSearch > 730) {
        daysToSearch = 730;
      }
      this._curSyncDayStep = daysToSearch;
    }

    // - Move the time range back in time more.
    var startTS, endTS;
    if (this._curSyncDir === PASTWARDS) {
      endTS = this._nextSyncAnchorTS;
      this._nextSyncAnchorTS = startTS = makeDaysBefore(endTS, daysToSearch,
                                                        this._account.tzOffset);
    }
    else { // FUTUREWARDS
      startTS = this._nextSyncAnchorTS;
      this._nextSyncAnchorTS = endTS = makeDaysBefore(startTS, -daysToSearch,
                                                      this._account.tzOffset);
    }
    this.folderConn.syncDateRange(startTS, endTS, this._curSyncAccuracyStamp,
                                  this.onSyncCompleted.bind(this));
  },

  /**
   * Invoked when there are no longer any live slices on the folder and no more
   * active/enqueued mutex ops.
   */
  allConsumersDead: function() {
    this.folderConn.relinquishConn();
  },

  shutdown: function() {
    this.folderConn.shutdown();
    this._LOG.__die();
  },
};

/**
 * ALL SPECULATIVE RIGHT NOW.
 *
 * Like ImapFolderStorage, but with only one folder and messages named by their
 * X-GM-MSGID value rather than their UID(s).
 *
 * Deletion processing operates slightly differently than for normal IMAP
 * because a message can be removed from one of the folders we synchronize on,
 * but not all of them.  We don't want to be overly deletionary in that case,
 * so we maintain a list of folder id's that are keeping each message alive.
 */
function GmailMessageStorage() {
}
GmailMessageStorage.prototype = {
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ImapFolderConn: {
    type: $log.CONNECTION,
    subtype: $log.CLIENT,
    events: {
    },
    TEST_ONLY_events: {
    },
    errors: {
      callbackErr: { ex: $log.EXCEPTION },

      htmlParseError: { ex: $log.EXCEPTION },
      htmlSnippetError: { ex: $log.EXCEPTION },
      textChewError: { ex: $log.EXCEPTION },
      textSnippetError: { ex: $log.EXCEPTION },

      // Attempted to sync with an empty or inverted range.
      illegalSync: { startTS: false, endTS: false },
    },
    asyncJobs: {
      syncDateRange: {
        newMessages: true, existingMessages: true, deletedMessages: true,
        start: false, end: false, skewedStart: false, skewedEnd: false,
      },
    },
  },
  ImapFolderSyncer: {
    type: $log.DATABASE,
    events: {
    }
  },
}); // end LOGFAB

}); // end define
