/**
 * synthetic_mouse_events.js: generate mouse events from touch events.
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
 *  should this code ever synthesize a click event?
 *  
 * XXX
 * How does this code interact with the contextmenu event?
 */

'use strict';

(function() {
  var starttouch;  // The Touch object that we started with
  var target;      // The element the touch is currently over
  var hasmoved;    // We'll set this to true if we get a touchmove

  // Listen for touch events that bubble up to the window.
  // If other code has called stopPropagation on the touch events
  // then we'll never see them. Also, we'll honor the defaultPrevented
  // state of the event and will not generate synthetic mouse events
  window.addEventListener('touchstart', handleTouchStart);
  window.addEventListener('touchmove', handleTouchMove);
  window.addEventListener('touchend', handleTouchEnd);
  window.addEventListener('touchcancel', handleTouchEnd); // Same as touchend

  // We don't do anything when a touch starts. If there is no touch move
  // then Gecko will send the mousedown, mouseup and click events. So for now
  // we just remember the starting touch event so that if it moves we can
  // take over and synthesize the mouse events
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
    hasmoved = false;
  }

  function handleTouchEnd(e) {
    if (!starttouch)
      return;

    for(var i = 0; i < e.changedTouches.length; i++) {
      var touch = e.changedTouches[i];
      // If the ended touch does not have the same id, skip it
      if (touch.identifier !== starttouch.identifier)
        continue;

      // If there has been a touchmove, then Gecko will not send any 
      // mouse events and we need to send them here. Note that 
      // calling preventDefault() on the touchend will not stop the 
      // mouseup event from being emitted. If the mousedown was sent
      // then we also send the mouseup
      if (hasmoved) {
        emitEvent('mouseup', target, touch);
      }

      starttouch = null;
      hasmoved = false;
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

      // If this is the first move we've seen, then we have to first
      // send out an initial mousemove and mousedown event
      if (!hasmoved) {
        hasmoved = true;
        emitEvent('mousemove', target, starttouch);
        emitEvent('mousedown', target, starttouch);
      }

      // We can't prevent the initial mousedown, but we can 
      // prevent the following mousemove events
      if (e.defaultPrevented)
        return;

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

      emitEvent('mousemove', target, touch);

      if (newtarget != oldtarget) {
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
    console.log('Sending', type);
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

    target.dispatchEvent(synthetic);
  }
}());
