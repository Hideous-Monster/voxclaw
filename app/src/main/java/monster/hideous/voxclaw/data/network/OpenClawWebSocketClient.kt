package monster.hideous.voxclaw.data.network

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * 🌐 WebSocket client for OpenClaw — the cable connecting us to the mothership.
 *
 * Currently a beautiful stub. Like a bass with no strings — the shape is right,
 * but we're not making sound yet. Phase 2 wires this up for real.
 *
 * Phase 2: Add @Singleton + @Inject constructor(private val okHttpClient: OkHttpClient)
 */
class OpenClawWebSocketClient(private val okHttpClient: OkHttpClient) {

    private var webSocket: WebSocket? = null

    /** Called when the server sends us a message. Swap in your handler. */
    var onMessageReceived: (String) -> Unit = {}

    // TODO: Make this configurable via DataStore settings (Phase 2)
    private val serverUrl = "ws://localhost:8080/ws"

    fun connect() {
        val request = Request.Builder().url(serverUrl).build()
        webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                onMessageReceived(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // 🔥 The amp blew up — handle reconnection in Phase 2
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // 🎬 Curtain down. See you next session.
            }
        })
    }

    fun disconnect() {
        webSocket?.close(1000, "Session ended")
        webSocket = null
    }

    fun sendText(message: String) {
        webSocket?.send(message)
    }
}
