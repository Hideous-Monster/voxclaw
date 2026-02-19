package monster.hideous.voxclaw

import android.app.Application
import monster.hideous.voxclaw.di.AppContainer

/**
 * 🎸 VoxClaw Application — the amp that powers everything.
 * Like plugging in your bass for the first time... pure potential energy.
 */
class VoxClawApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
