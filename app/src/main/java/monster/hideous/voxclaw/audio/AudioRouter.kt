package monster.hideous.voxclaw.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

/**
 * 🔊 Audio Router — the sound engineer making sure everything goes through
 * the right speakers. Bluetooth SCO for the car, audio focus so we don't
 * get interrupted mid-riff by a notification jingle.
 *
 * Not activated yet — just the utility, tuned and ready to shred.
 *
 * Phase 2: Add @Singleton + @Inject constructor(@ApplicationContext private val context: Context)
 */
class AudioRouter(private val context: Context) {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null
    private var scoReceiverRegistered = false

    // 🎧 Bluetooth SCO state listener — are the wireless cans connected?
    private val scoReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)) {
                AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                    // 🔗 Bluetooth SCO live — car audio ready to rumble
                }
                AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                    // 🔌 Bluetooth SCO dropped — falling back to built-in speaker
                }
            }
        }
    }

    fun setupBluetoothSco() {
        if (!scoReceiverRegistered) {
            context.registerReceiver(
                scoReceiver,
                IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED),
            )
            scoReceiverRegistered = true
        }
        audioManager.startBluetoothSco()
    }

    fun releaseBluetoothSco() {
        audioManager.stopBluetoothSco()
        if (scoReceiverRegistered) {
            try {
                context.unregisterReceiver(scoReceiver)
            } catch (_: IllegalArgumentException) {
                // Already unregistered — no drama
            }
            scoReceiverRegistered = false
        }
    }

    /** Returns true if audio focus was granted. */
    fun requestAudioFocus(): Boolean {
        val focusRequest = AudioFocusRequest
            .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setOnAudioFocusChangeListener { focusChange ->
                when (focusChange) {
                    AudioManager.AUDIOFOCUS_LOSS -> { /* 😤 Someone stole our spotlight */ }
                    AudioManager.AUDIOFOCUS_GAIN -> { /* 🎉 We're back, baby! */ }
                }
            }
            .build()

        audioFocusRequest = focusRequest
        return audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    fun abandonAudioFocus() {
        audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
    }
}
