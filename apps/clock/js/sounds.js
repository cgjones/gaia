define(function(require, exports) {
  'use strict';
  
  var _ = require('l10n').get;

  // Sadly, this is needed because when sound l10n ids change, they no
  // longer match up with the sound filename.
  var SOUND_FILE_TO_L10N_ID = {
    '0': 'noSound',
    'ac_awake.opus': 'ac_awake_opus',
    'ac_crystalize.opus': 'ac_crystalize_opus',
    'ac_cycle.opus': 'ac_cycle_opus',
    'ac_digicloud.opus': 'ac_digicloud_opus',
    'ac_humming_waves.opus': 'ac_humming_waves_opus',
    'ac_into_the_void.opus': 'ac_into_the_void_opus',
    'ac_lightly.opus': 'ac_lightly_opus',
    'ac_mobile.opus': 'ac_mobile_opus',
    'ac_pinger.opus': 'ac_pinger_opus',
    'ac_skip.opus': 'ac_skip_opus',
    'ac_tri.opus': 'ac_tri_opus',
    'ac_universal.opus': 'ac_universal_opus'
  };

  /**
   * Given a sound ID, return the label to be displayed, for instance,
   * on a FormButton.
   */
  exports.formatLabel = function(sound) {
    return (sound === null || sound === '0') ?
      _('noSound') : _(SOUND_FILE_TO_L10N_ID[sound]);
  };
});
