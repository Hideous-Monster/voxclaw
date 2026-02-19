package monster.hideous.voxclaw.di

import android.content.Context
import monster.hideous.voxclaw.audio.AudioRouter
import monster.hideous.voxclaw.data.network.OpenClawWebSocketClient
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * 🏗️ AppContainer — the roadie who sets up all our gear before the show.
 *
 * Simple manual DI: singleton instances, created lazily, shared app-wide.
 * Initialize once from VoxClawApp.onCreate() and access via VoxClawApp.container.
 */
class AppContainer(private val appContext: Context) {

    val okHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS) // WebSockets need infinite read timeout
            .build()
    }

    val webSocketClient: OpenClawWebSocketClient by lazy {
        OpenClawWebSocketClient(okHttpClient)
    }

    val audioRouter: AudioRouter by lazy {
        AudioRouter(appContext)
    }
}
