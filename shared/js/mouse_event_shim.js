/**
 * mouse_event_shim.js: generate mouse events from touch events.
 *   Capture and discard any mouse events that gecko sends so we
 *   don't get duplicates.
 * 
 *   This library does not support multi-touch but should be sufficient
 *   to do drags based on mousedown/mousemove/mouseup events.
 * 
 * XXX
 *  we do not currently emit mouseenter/mouseleave
 *  events. Maybe these should be optional, and users of this library
 *  can enable them if they are needed.
 *
 * XXX
 *  do I need to deal with dblclick events?
 *  
 * XXX
 * How does this code interact with the contextmenu event?
 */

'use strict';

(function() {
  // Make sure we don't run more than once
  if (MouseEventShim)
    return;

  var starttouch;  // The Touch object that we started with
  var target;      // The element the touch is currently over
  var wantsclick;  // Will we be sending a click event after mouseup?

  // Use capturing listeners to discard all mouse events from gecko
  window.addEventListener('mousedown', discardEvent, true);
  window.addEventListener('mouseup', discardEvent, true);
  window.addEventListener('mousemove', discardEvent, true);
  window.addEventListener('click', discardEvent, true);

  function discardEvent(e) {
    if (e.isTrusted) 
      e.stopImmediatePropagation();
  }

  // Listen for touch events that bubble up to the window.
  // If other code has called stopPropagation on the touch events
  // then we'll never see them. Also, we'll honor the defaultPrevented
  // state of the event and will not generate synthetic mouse events
  window.addEventListener('touchstart', handleTouchStart);
  window.addEventListener('touchmove', handleTouchMove);
  window.addEventListener('touchend', handleTouchEnd);
  window.addEventListener('touchcancel', handleTouchEnd); // Same as touchend

  function handleTouchStart(e) {
    // If we're already handling a touch, ignore this one
    if (starttouch) 
      return;

    // Ignore any event that has already been prevented
    if (e.defaultPrevented)
      return;

    // If there is more than one similtaneous touch, ignore all but the first
    starttouch = e.changedTouches[0];
    target = starttouch.target;
    wantsclick = true;

    // Move to the position of the touch
    emitEvent('mousemove', target, starttouch);

    // Now send a synthetic mousedown
    var result = emitEvent('mousedown', target, starttouch);

    // If the mousedown was prevented, pass that on to the touch event.
    // And remember not to send a click event
    if (!result) {
      e.preventDefault();
      wantsclick = false;
    }
  }

  function handleTouchEnd(e) {
    if (!starttouch)
      return;

    for(var i = 0; i < e.changedTouches.length; i++) {
      var touch = e.changedTouches[i];
      // If the ended touch does not have the same id, skip it
      if (touch.identifier !== starttouch.identifier)
        continue;

      emitEvent('mouseup', target, touch);

      // If target is still the same element we started on send a click, too
      // Unless the user prevented the click on mousedown
      if (target === starttouch.target && wantsclick)
        emitEvent('click', target, touch);

      starttouch = null;
      return;
    }
  }

  function handleTouchMove(e) {
    if (!starttouch)
      return;

    for(var i = 0; i < e.changedTouches.length; i++) {
      var touch = e.changedTouches[i];
      // If the ended touch does not have the same id, skip it
      if (touch.identifier !== starttouch.identifier)
        continue;

      // Don't send a mousemove if the touchmove was prevented
      if (e.defaultPrevented)
        return;

      var tracking = MouseEventShim.trackMouseMoves;

      if (tracking) {
        // If the touch point moves, then the element it is over
        // may have changed as well. Note that calling elementFromPoint()
        // forces a layout if one is needed.
        // XXX: how expensive is it to do this on each touchmove?
        // Can we listen for (non-standard) touchleave events instead?
        var oldtarget = target;
        var newtarget = document.elementFromPoint(touch.clientX, touch.clientY);
        if (newtarget === null) {
          console.warn('document.elementFromPoint returned null');
          newtarget = oldtarget;
        }
        if (newtarget != oldtarget) {
          // XXX: emit events here (mouseleave? mouseout?)
          // mouseout is easy: just emit it and let it bubble
          // mouseleave is harder because we may have left multiple
          // elements in the containment hieararchy, so we have to 
          // traverse up the parentNode chain and fire a mouseleave on
          // every container element that has been left.
          // See: http://dev.w3.org/2006/webapi/DOM-Level-3-Events/html/DOM3-Events.html#events-mouseevent-event-order
          // to get the event order right for these
          leave(oldtarget, newtarget, touch);
          target = newtarget;
        }
      }

      emitEvent('mousemove', target, touch);

      if (tracking && newtarget != oldtarget) {
        enter(newtarget, oldtarget, touch);
      }
    }
  }

  // Return true if element a contains element b
  function contains(a, b) {
    return (a.compareDocumentPosition(b) & 16) !== 0;
  }

  // A touch has left oldtarget and entered newtarget
  // Send out all the events that are required
  function leave(oldtarget, newtarget, touch) {
    emitEvent('mouseout', oldtarget, touch, newtarget);
  }

  // A touch has entered newtarget from oldtarget
  // Send out all the events that are required
  function enter(newtarget, oldtarget, touch) {
    emitEvent('mouseover', newtarget, touch, oldtarget);
  }

  function emitEvent(type, target, touch, relatedTarget) {
    var synthetic = document.createEvent('MouseEvents');
    var bubbles = (type !== 'mouseenter' && type !== 'mouseleave');
    var count =
      (type === 'mousedown' || type === 'mouseup' || type === 'click') ? 1 : 0;

    synthetic.initMouseEvent(type, 
                             bubbles,     // canBubble
                             true,        // cancelable
                             window, 
                             count,       // detail: click count
                             touch.screenX,
                             touch.screenY,
                             touch.clientX,
                             touch.clientY,
                             false,       // ctrlKey: we don't have one
                             false,       // altKey: we don't have one
                             false,       // shiftKey: we don't have one
                             false,       // metaKey: we don't have one
                             0,           // we're simulating the left button
                             relatedTarget || null);

    return target.dispatchEvent(synthetic);
  }
}());

var MouseEventShim = {
  // It is a known gecko bug that synthetic events have timestamps measured
  // in microseconds while regular events have timestamps measured in
  // milliseconds. This utility function returns a the timestamp converted
  // to milliseconds, if necessary.
  getEventTimestamp: function(e) {
    // XXX: Are real events always trusted?
    if (e.isTrusted)
      return e.timeStamp;
    else
      return e.timeStamp/1000;
  },

  // Set this to false if you don't care about mouseover/out events
  // and don't want the target of mousemove events to follow the touch
  trackMouseMoves: true,
};
