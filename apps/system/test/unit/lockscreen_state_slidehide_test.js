/* global LockScreenStateSlideHide */

'use strict';
requireApp('system/js/lockscreen_state_slidehide.js');
suite('sytem/LockScreenStateSlideHide', function() {
  var subject;
  var mockLockScreen;
  setup(function() {
    mockLockScreen = {
      overlay: document.createElement('div')
    };
    subject = (new LockScreenStateSlideHide()).start(mockLockScreen);
  });
  test('it would resolve as expected', function(done) {
    subject.transferTo().then(done, done);
  });
});
