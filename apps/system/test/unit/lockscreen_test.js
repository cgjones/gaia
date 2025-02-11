'use strict';

require('/shared/test/unit/mocks/mock_l10n.js');
require('/shared/test/unit/mocks/mock_image.js');
require('/shared/test/unit/mocks/mock_canvas.js');
require('/shared/test/unit/mocks/mock_canvas_rendering_context_2d.js');
requireApp('system/shared/test/unit/mocks/mock_settings_listener.js');
requireApp('system/shared/test/unit/mocks/mock_navigator_moz_settings.js');
requireApp('system/shared/test/unit/mocks/mock_navigator_moz_telephony.js');
requireApp('system/test/unit/mock_ftu_launcher.js');
requireApp('system/test/unit/mock_app_window_manager.js');
requireApp('system/test/unit/mock_app_window.js');
requireApp('system/test/unit/mock_lockscreen_slide.js');
requireApp('system/test/unit/mock_clock.js', function() {
  window.realClock = window.Clock;
  window.Clock = window.MockClock;
  requireApp('system/test/unit/mock_orientation_manager.js',
    function() {
      window.realOrientationManager = window.OrientationManager;
      window.OrientationManager = window.MockOrientationManager;
      requireApp('system/js/lockscreen.js');
    });
});

if (!this.FtuLauncher) {
  this.FtuLauncher = null;
}

if (!this.SettingsListener) {
  this.SettingsListener = null;
}

var mocksForLockScreen = new window.MocksHelper([
  'OrientationManager', 'AppWindowManager', 'AppWindow', 'LockScreenSlide',
  'Clock', 'SettingsListener', 'Image', 'Canvas'
]).init();

requireApp('system/test/unit/mock_clock.js', function() {
  window.realClock = window.Clock;
  window.Clock = window.MockClock;
  requireApp('system/test/unit/mock_orientation_manager.js',
    function() {
      window.realOrientationManager = window.OrientationManager;
      window.OrientationManager = window.MockOrientationManager;
      requireApp('system/js/lockscreen.js');
    });
});

suite('system/LockScreen >', function() {
  var subject;
  var realL10n;
  var realMozTelephony;
  var realClock;
  var realOrientationManager;
  var realFtuLauncher;
  var realSettingsListener;
  var realMozSettings;
  var domPasscodePad;
  var domEmergencyCallBtn;
  var domOverlay;
  var domPasscodeCode;
  var domMainScreen;
  var domCamera;
  var stubById;
  var domMessage;
  var mockGetAllElements;
  mocksForLockScreen.attachTestHelpers();

  setup(function() {
    stubById = sinon.stub(document, 'getElementById');
    stubById.returns(document.createElement('div'));
    mockGetAllElements = function() {
      ['area', 'areaCamera', 'areaUnlock', 'altCameraButton', 'iconContainer',
       'overlay', 'clockTime', 'date'].forEach(function(name) {
          subject[name] = document.createElement('div');
      });
    };

    window.lockScreenNotifications = {
      bindLockScreen: function() {}
    };
    window.LockScreenConnInfoManager = function() {
      this.updateConnStates = function() {};
    };
    window.MediaPlaybackWidget = function() {};
    window.SettingsURL = function() {};

    realL10n = navigator.mozL10n;
    navigator.mozL10n = window.MockL10n;

    realMozTelephony = navigator.mozTelephony;
    navigator.mozTelephony = window.MockNavigatorMozTelephony;

    realClock = window.Clock;
    window.Clock = window.MockClock;

    realOrientationManager = window.OrientationManager;
    window.OrientationManager = window.MockOrientationManager;

    realFtuLauncher = window.FtuLauncher;
    window.FtuLauncher = window.MockFtuLauncher;

    realSettingsListener = window.SettingsListener;
    window.SettingsListener = window.MockSettingsListener;

    realMozSettings = navigator.mozSettings;
    navigator.mozSettings = window.MockNavigatorSettings;

    subject = new window.LockScreen();

    domCamera = document.createElement('div');
    domPasscodePad = document.createElement('div');
    domPasscodePad.id = 'lockscreen-passcode-pad';
    domEmergencyCallBtn = document.createElement('a');
    domEmergencyCallBtn.dataset.key = 'e';
    domPasscodePad.appendChild(domEmergencyCallBtn);
    domOverlay = document.createElement('div');
    domPasscodeCode = document.createElement('div');
    document.body.appendChild(domPasscodePad);
    domMainScreen = document.createElement('div');
    subject.passcodePad = domPasscodePad;
    domMessage = document.createElement('div');
    subject.message = domMessage;

    var mockClock = {
      start: function() {},
      stop: function() {}
    };
    subject.overlay = domOverlay;
    subject.mainScreen = domMainScreen;
    subject.clock = mockClock;
    subject.camera = domCamera;
    subject.lock();
  });

  test('Emergency call: should disable when has no telephony', function() {
    navigator.mozTelephony = null;
    var stubGetAll = this.sinon.stub(subject, 'getAllElements',
                      mockGetAllElements);
    var spyEmergencyCallEvents = this.sinon.spy(subject,
                                  'initEmergencyCallEvents');
    subject.init();
    assert.isTrue(domEmergencyCallBtn.classList.contains('disabled'));
    assert.isFalse(spyEmergencyCallEvents.calledOnce);
  });

  test('Emergency call: should enable when has telephony', function() {
    var stubGetAll = this.sinon.stub(subject, 'getAllElements',
                      mockGetAllElements);
    var spyEmergencyCallEvents = this.sinon.spy(subject,
                                  'initEmergencyCallEvents');
    subject.init();
    assert.isFalse(domEmergencyCallBtn.classList.contains('disabled'));
    assert.isTrue(spyEmergencyCallEvents.calledOnce);
  });

  test('Emergency call: should disable emergency-call button',
    function() {
      var stubSwitchPanel = this.sinon.stub(subject, 'switchPanel');
      navigator.mozTelephony.calls = {length: 1};
      var evt = {type: 'callschanged'};
      subject.handleEvent(evt);
      assert.isTrue(domEmergencyCallBtn.classList.contains('disabled'));
      stubSwitchPanel.restore();
  });

  test('Emergency call: should enable emergency-call button',
    function() {
      var stubSwitchPanel = this.sinon.stub(subject, 'switchPanel');
      navigator.mozTelephony.calls = {length: 0};
      var evt = {type: 'callschanged'};
      subject.handleEvent(evt);
      assert.isFalse(domEmergencyCallBtn.classList.contains('disabled'));
      stubSwitchPanel.restore();
  });

  test('Lock: can actually lock', function() {
    subject.overlay = domOverlay;
    subject.lock();
    assert.isTrue(subject.locked);
  });

  test('Unlock: can actually unlock', function() {
    subject.overlay = domOverlay;
    subject.unlock(true);
    assert.isFalse(subject.locked);
  });

  test('Passcode: enter passcode should fire the validation event', function() {
    var stubDispatchEvent = this.sinon.stub(window, 'dispatchEvent');
    subject.passCodeEntered = 'foobar';
    subject.checkPassCode();
    assert.isTrue(stubDispatchEvent.calledWithMatch(function(event) {
      return 'lockscreen-request-passcode-validate' === event.type &&
        'foobar' === event.detail.passcode;
    }),
    'it did\'t fire the correspond event to validate the passcode');
  });

  suite('Handle event: screenchange should propogate to _screenEnabled prop',
    function() {
      var stubDispatch;
      setup(function() {
        stubDispatch = this.sinon.stub(window, 'dispatchEvent');
        subject._screenEnabled = undefined;
      });
      test('True', function() {
        subject.handleEvent({
          type: 'screenchange',
          detail: {screenEnabled: true}
        });
        assert.isTrue(subject._screenEnabled);
      });
      test('False', function() {
        subject.handleEvent({
          type: 'screenchange',
          detail: {screenEnabled: false}
        });
        assert.isFalse(subject._screenEnabled);
      });
  });

  test('Handle event: when screen changed,' +
      'would fire event to kill all secure apps',
      function() {
        var stubDispatch = this.sinon.stub(window, 'dispatchEvent');
        subject.handleEvent({type: 'screenchange', detail: {}});
        assert.isTrue(stubDispatch.calledWithMatch(sinon.match(
              function(e) {
                return e.type === 'secure-killapps';
              })),
          'the event was not fired');
        stubDispatch.restore();
      });

  test('Handle event: when press home,' +
      'would fire event to close all secure apps',
      function() {
        subject.lock();
        var stubDispatch = this.sinon.stub(window, 'dispatchEvent');
        subject.handleEvent({type: 'home', detail: {},
          stopImmediatePropagation: function() {}});
        assert.isTrue(stubDispatch.calledWithMatch(sinon.match(
              function(e) {
                return e.type === 'secure-closeapps';
              })),
          'the event was not fired');
        stubDispatch.restore();
      });

  test('Handle event: when unlock,' +
      'would fire event to turn secure mode off',
      function() {
        var stubDispatch = this.sinon.stub(window, 'dispatchEvent');
        subject.unlock();
        assert.isTrue(stubDispatch.calledWithMatch(sinon.match(
              function(e) {
                return e.type === 'secure-modeoff';
              })),
          'the event was not fired');
        stubDispatch.restore();
      });

  test('Handle event: when timeformat changed,' +
      'would fire event to refresh the clock',
      function() {
        var stubRefreshClock = this.sinon.stub(subject, 'refreshClock');
        subject.handleEvent(new CustomEvent('timeformatchange'));
        assert.isTrue(stubRefreshClock.called,
          'the refreshClock wasn\'t called even after the time format changed');
      });

  test('Handle event: when lock,' +
      'would fire event to turn secure mode on',
      function() {
        subject.unlock();
        var stubDispatch = this.sinon.stub(window, 'dispatchEvent');
        subject.lock();
        assert.isTrue(stubDispatch.calledWithMatch(sinon.match(
              function(e) {
                return e.type === 'secure-modeon';
              })),
          'the event was not fired');
        stubDispatch.restore();
      });

  test('Switch panel: to Camera; should notify SecureWindowFactory\'s method',
    function() {
      var stubDispatch = this.sinon.stub(window, 'dispatchEvent');
      subject.invokeSecureApp('camera');
      assert.isTrue(stubDispatch.calledWithMatch(sinon.match(function(e) {
          return 'secure-launchapp' === e.type;
        })),
        'the corresponding creation method was no invoked');
      stubDispatch.restore();
    });

  test('Message: message should appear on screen when set', function() {
    var message = 'message';
    subject.setLockMessage(message);
    assert.equal(subject.message.hidden, false);
    assert.equal(subject.message.textContent, message);
  });

  test('Message: message should disappear when unset', function() {
    subject.setLockMessage('');
    assert.equal(subject.message.textContent, '');
    assert.equal(subject.message.hidden, true);
  });

  test('Lock when asked via lock-immediately setting', function() {
    window.MockNavigatorSettings.mTriggerObservers(
      'lockscreen.lock-immediately', {settingValue: true});
    assert.isTrue(subject.locked,
      'it didn\'t lock after the lock-immediately setting got changed');
  });

  // XXX: Test 'Screen off: by proximity sensor'.

  suite('Background functionality', function() {
    var bgURL = 'blob:app://wallpaper.gaiamobile.org/b10b-1d';

    suite('updateBackground', function() {
      var stubGenerate;

      setup(function() {
        stubGenerate =
          this.sinon.stub(subject, '_generateMaskedBackgroundColor');
      });

      test('updateBackground, Screen is not enabled and not locked',
        function() {
        subject._screenEnabled = false;
        subject.locked = false;
        subject.updateBackground(bgURL);
        var bgElem = stubById.getCall(0).returnValue;
        assert.equal(bgElem.style.backgroundImage, 'url("' + bgURL + '")');
        assert.equal(subject._regenerateMaskedBackgroundColorFrom, bgURL);
        assert.isFalse(stubGenerate.called);
        assert.isTrue(subject._shouldRegenerateMaskedBackgroundColor);
      });

      test('updateBackground, Screen is enabled and not locked', function() {
        subject._screenEnabled = true;
        subject.locked = false;
        subject.updateBackground(bgURL);
        var bgElem = stubById.getCall(0).returnValue;
        assert.equal(bgElem.style.backgroundImage, 'url("' + bgURL + '")');
        assert.equal(subject._regenerateMaskedBackgroundColorFrom, bgURL);
        assert.isFalse(stubGenerate.called);
        assert.isTrue(subject._shouldRegenerateMaskedBackgroundColor);
      });

      test('updateBackground, Screen is not enabled and is locked', function() {
        subject._screenEnabled = false;
        subject.locked = true;
        subject.updateBackground(bgURL);
        var bgElem = stubById.getCall(0).returnValue;
        assert.equal(bgElem.style.backgroundImage, 'url("' + bgURL + '")');
        assert.equal(subject._regenerateMaskedBackgroundColorFrom, bgURL);
        assert.isFalse(stubGenerate.called);
        assert.isTrue(subject._shouldRegenerateMaskedBackgroundColor);
      });

      var testScreenEnabledAndLocked = function testScreenEnabledAndLocked() {
        subject.locked = true;
        subject.updateBackground(bgURL);
        var bgElem = stubById.getCall(0).returnValue;
        assert.equal(bgElem.style.backgroundImage, 'url("' + bgURL + '")');
        assert.equal(subject._regenerateMaskedBackgroundColorFrom, bgURL);
        assert.isTrue(stubGenerate.called);
        assert.isFalse(subject._shouldRegenerateMaskedBackgroundColor);
      };

      test('updateBackground, Screen is enabled and is locked', function() {
        subject._screenEnabled = true;
        testScreenEnabledAndLocked();
      });

      test('updateBackground, _screenEnabled = undefined is regarded as ' +
           'screen is enabled', function() {
        subject._screenEnabled = undefined;
        testScreenEnabledAndLocked();
      });
    });

    test('checkGenerateMaskedBackgroundColor', function() {
      subject._shouldRegenerateMaskedBackgroundColor = true;
      subject._regenerateMaskedBackgroundColorFrom = bgURL;
      assert.isTrue(subject._checkGenerateMaskedBackgroundColor());

      subject._shouldRegenerateMaskedBackgroundColor = false;
      subject._regenerateMaskedBackgroundColorFrom = undefined;
      assert.isFalse(subject._checkGenerateMaskedBackgroundColor());
    });

    suite('generateMaskedBackgroundColor', function() {
      // unit-test the function is a bit tricky: first we use the mocked image
      // object (and set fake height/width). then we use the mocked canvas
      // object that returns a image data that would calculate into red
      // (#ff0000), green (#00ff00), and blue (#0000ff) for each of the three
      // tests respectively, and we match the calculatd hsl against the known
      // result.
      // i.e. the image src fed into the function is actually not used in the
      // calculation, for the test's sake.

      var mockCanvas;
      var mockContext;
      var mockBgElem;
      var img;
      var canvasWidth;
      var canvasHeight;
      var fakeImageData;

      setup(function() {
        mockCanvas = new MockCanvas();
        this.sinon.stub(document, 'createElement').returns(mockCanvas);

        mockContext = new MockCanvasRenderingContext2D();

        mockBgElem = {
          dataset: {},
          classList: {
            contains: this.sinon.stub().returns(true)
          },
          style: {}
        };

        subject.maskedBackground = mockBgElem;

        MockImage.teardown();

        subject._regenerateMaskedBackgroundColorFrom = bgURL;
        subject._generateMaskedBackgroundColor();

        assert.isFalse(subject._shouldRegenerateMaskedBackgroundColor);
        assert.strictEqual(
          subject._regenerateMaskedBackgroundColorFrom,
          undefined
        );

        img = MockImage.instances[0];
        img.width = 100;
        img.height = 100;

        canvasWidth = img.width * window.devicePixelRatio;
        canvasHeight = img.height * window.devicePixelRatio;

        this.sinon.stub(mockCanvas, 'getContext').returns(mockContext);

        // fill the fake imagedata with all red
        fakeImageData = [];
      });

      test('red', function() {
        for (var row = 0; row < canvasHeight; row++) {
          for (var col = 0; col < canvasWidth; col++) {
            fakeImageData[((canvasWidth * row) + col) * 4] = 255; // r
            fakeImageData[((canvasWidth * row) + col) * 4 + 1] = 0; // g
            fakeImageData[((canvasWidth * row) + col) * 4 + 2] = 0; // b
          }
        }

        this.sinon.stub(mockContext, 'getImageData').returns({
          data: fakeImageData
        });

        img.triggerEvent('onload');

        assert.equal(
          mockBgElem.dataset.wallpaperColor,
          'hsla(0, 100%, 45%, 0.7)'
        );
        assert.isFalse('backgroundColor' in mockBgElem.style);
      });

      test('green', function() {
        for (var row = 0; row < canvasHeight; row++) {
          for (var col = 0; col < canvasWidth; col++) {
            fakeImageData[((canvasWidth * row) + col) * 4] = 0; // r
            fakeImageData[((canvasWidth * row) + col) * 4 + 1] = 255; // g
            fakeImageData[((canvasWidth * row) + col) * 4 + 2] = 0; // b
          }
        }

        this.sinon.stub(mockContext, 'getImageData').returns({
          data: fakeImageData
        });

        img.triggerEvent('onload');

        assert.equal(
          mockBgElem.dataset.wallpaperColor,
          'hsla(120, 100%, 45%, 0.7)'
        );
        assert.isFalse('backgroundColor' in mockBgElem.style);
      });

      test('blue', function() {
        for (var row = 0; row < canvasHeight; row++) {
          for (var col = 0; col < canvasWidth; col++) {
            fakeImageData[((canvasWidth * row) + col) * 4] = 0; // r
            fakeImageData[((canvasWidth * row) + col) * 4 + 1] = 0; // g
            fakeImageData[((canvasWidth * row) + col) * 4 + 2] = 255; // b
          }
        }

        this.sinon.stub(mockContext, 'getImageData').returns({
          data: fakeImageData
        });

        img.triggerEvent('onload');

        assert.equal(
          mockBgElem.dataset.wallpaperColor,
          'hsla(240, 100%, 45%, 0.7)'
        );
        assert.isFalse('backgroundColor' in mockBgElem.style);
      });

      test('red & update background style directly', function() {
        for (var row = 0; row < canvasHeight; row++) {
          for (var col = 0; col < canvasWidth; col++) {
            fakeImageData[((canvasWidth * row) + col) * 4] = 255; // r
            fakeImageData[((canvasWidth * row) + col) * 4 + 1] = 0; // g
            fakeImageData[((canvasWidth * row) + col) * 4 + 2] = 0; // b
          }
        }

        this.sinon.stub(mockContext, 'getImageData').returns({
          data: fakeImageData
        });

        mockBgElem.classList.contains.returns(false);

        img.triggerEvent('onload');

        assert.isTrue(mockBgElem.classList.contains.calledWith('blank'));
        assert.equal(
          mockBgElem.style.backgroundColor,
          'hsla(0, 100%, 45%, 0.7)'
        );
      });
    });
  });

  teardown(function() {
    navigator.mozL10n = realL10n;
    navigator.mozTelephony = realMozTelephony;
    window.Clock = window.realClock;
    window.OrientationManager = window.realOrientationManager;
    window.FtuLauncher = realFtuLauncher;
    window.SettingsListener = realSettingsListener;
    navigator.mozSettings = realMozSettings;

    document.body.removeChild(domPasscodePad);
    subject.passcodePad = null;

    window.MockSettingsListener.mTeardown();
    window.MockNavigatorSettings.mTeardown();
    stubById.restore();
  });
});
