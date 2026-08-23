package cn.motionbridge.camera

import android.content.res.AssetManager
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import org.json.JSONObject

/**
 * v0.9.4: one-stage, full-phrase KWS.
 * AudioRecord -> sherpa KWS("体感截图"/"体感加速"/...) -> command_id + phrase.
 * No wake state, no VAD, no second-stage ASR, no audio upload.
 */
class LocalVoiceEngine(private val assets: AssetManager) {
    companion object {
        const val SAMPLE_RATE = 16_000
        private const val KWS_DIR = "voice/kws"
    }

    data class EngineEvent(val kind: String, val phrase: String = "", val commandId: String = "", val label: String = "")

    private val kws: KeywordSpotter
    private var stream: OnlineStream
    private var lastTriggerMs = 0L
    private val actionMap: JSONObject

    init {
        actionMap = JSONObject(loadAssetText("$KWS_DIR/voice_action_map.json"))
        val feat = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80)
        val model = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig(
                encoder = "$KWS_DIR/encoder.int8.onnx",
                decoder = "$KWS_DIR/decoder.onnx",
                joiner = "$KWS_DIR/joiner.int8.onnx"
            ),
            tokens = "$KWS_DIR/tokens.txt",
            numThreads = 1,
            provider = "cpu"
        )
        kws = KeywordSpotter(
            assetManager = assets,
            config = KeywordSpotterConfig(
                featConfig = feat,
                modelConfig = model,
                keywordsFile = "$KWS_DIR/keywords.txt",
                keywordsScore = 1.0f,
                keywordsThreshold = 0.25f,
                numTrailingBlanks = 1
            )
        )
        stream = kws.createStream()
    }

    private fun loadAssetText(path: String): String {
        assets.open(path).use { input ->
            return input.bufferedReader().use { it.readText() }
        }
    }

    private fun compact(s: String): String {
        return s.replace(Regex("[\\s\u3000，。！？、,.!?;；:：]+"), "").lowercase()
    }

    private fun lookupCommandId(phrase: String): String {
        val key = compact(phrase)
        if (actionMap.has(key)) {
            return actionMap.getJSONObject(key).getString("id")
        }
        return ""
    }

    private fun lookupAction(phrase: String): Pair<String, String> {
        val key = compact(phrase)
        if (actionMap.has(key)) {
            val obj = actionMap.getJSONObject(key)
            return Pair(obj.getString("id"), obj.optString("label", ""))
        }
        return Pair("", "")
    }

    @Synchronized
    fun acceptFrame(pcm: ShortArray): EngineEvent? {
        if (pcm.isEmpty()) return null
        val samples = FloatArray(pcm.size) { pcm[it] / 32768.0f }
        stream.acceptWaveform(samples, sampleRate = SAMPLE_RATE)
        while (kws.isReady(stream)) {
            kws.decode(stream)
            val phrase = kws.getResult(stream).keyword.trim()
            if (phrase.isNotEmpty()) {
                kws.reset(stream)
                val now = android.os.SystemClock.elapsedRealtime()
                val isEmergency = phrase.contains("紧急停止")
                if (now - lastTriggerMs < 650L && !isEmergency) return null
                lastTriggerMs = now
                val (commandId, label) = lookupAction(phrase)
                return EngineEvent("command", phrase, commandId, label)
            }
        }
        return null
    }

    @Synchronized
    fun reset() {
        kws.reset(stream)
        lastTriggerMs = 0L
    }

    @Synchronized
    fun release() {
        try {
            stream.release()
        } catch (_: Throwable) {
        }
        try {
            kws.release()
        } catch (_: Throwable) {
        }
    }
}
