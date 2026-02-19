package monster.hideous.voxclaw.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder

/**
 * 🥁 VoxClaw Foreground Service — the drummer that keeps the beat going
 * even when the app is in the background. Persistent, reliable, unstoppable.
 *
 * Will host audio recording and WebSocket connections in Phase 2.
 * For now: shows the notification, holds the stage.
 *
 * Phase 2: Add @AndroidEntryPoint (requires Hilt activation first)
 */
class VoxClawService : Service() {

    companion object {
        const val CHANNEL_ID = "voxclaw_session"
        const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, VoxClawService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoxClawService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        // 🔇 The set is over. Roadies pack up the gear.
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "VoxClaw Session",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Active voice conversation session"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification =
        Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("VoxClaw")
            .setContentText("VoxClaw is listening 🎤")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
}
