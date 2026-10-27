/* Use installed voices only: listening never calls a paid speech service or the model. */
(function (PR) {
  "use strict";

  PR.selectionSpeech = function (root, text) {
    const synth = window.speechSynthesis, Utterance = window.SpeechSynthesisUtterance;
    const normal = root.querySelector("[data-st-speak]"), slow = root.querySelector("[data-st-slow]");
    const stop = root.querySelector("[data-st-stop]"), status = root.querySelector("[data-st-speech-status]");
    const accent = root.querySelector("[data-st-accent]");
    const voiceSelect = root.querySelector("[data-st-voice]");
    const language = /[\u3400-\u9fff]/u.test(text) ? "zh" : "en";
    const preferenceKey = "easyread-speech-accent";
    accent.value = PR.ls.get(preferenceKey, "en-US") === "en-GB" ? "en-GB" : "en-US";
    accent.hidden = language !== "en";
    if (!synth || !Utterance) {
      accent.disabled = true;
      voiceSelect.replaceChildren(PR.el("option", { text: PR.t("无可用音色") }));
      status.textContent = PR.t("当前浏览器不支持朗读");
      return { dispose() {} };
    }
    let voice = null, utterance = null, disposed = false, available = [];
    const voiceId = v => v.voiceURI || v.name;
    const voicePreference = () => "easyread-speech-voice-" + (language === "en" ? accent.value : "zh");
    const localStatus = () => PR.t("本地语音 · {n} 个音色", { n: available.length });

    function defaultVoice(voices, locale) {
      // macOS lists legacy/effect voices before ordinary reading voices.
      // Prefer these only when installed; other systems use their own default.
      const names = { "en-us": ["Samantha", "Alex"], "en-gb": ["Daniel"] }[locale] || [];
      for (const name of names) {
        const match = voices.find(v => v.name === name || v.name.startsWith(name + " (") || v.name.startsWith(name + "（")); // i18n-ok: system voice names
        if (match) return match;
      }
      return voices.find(v => v.default) || voices[0];
    }

    function refreshVoices() {
      const voices = synth.getVoices().filter(v => v.localService && v.lang.toLowerCase().split(/[-_]/)[0] === language);
      const preferred = language === "zh" ? "zh-cn" : accent.value.toLowerCase();
      available = voices.filter(v => v.lang.toLowerCase().replace(/_/g, "-") === preferred);
      if (language === "zh" && !available.length) available = voices;
      const saved = PR.ls.get(voicePreference(), "");
      voice = available.find(v => voiceId(v) === saved) || defaultVoice(available, preferred);
      voiceSelect.replaceChildren(...(available.length ? available.map(v => PR.el("option", { value: voiceId(v), text: v.name }))
        : [PR.el("option", { value: "", text: PR.t("无可用音色") })]));
      voiceSelect.value = voice ? voiceId(voice) : "";
      voiceSelect.disabled = !voice;
      normal.disabled = slow.disabled = !voice;
      if (!utterance) status.textContent = voice ? localStatus() : language === "zh"
        ? PR.t("未找到本地语音，请在系统中安装对应语言的语音包")
        : accent.value === "en-GB" ? PR.t("未找到本地英音，请在系统中安装英语（英国）语音包")
          : PR.t("未找到本地美音，请在系统中安装英语（美国）语音包");
    }
    function finish(current, error) {
      // A canceled utterance can report an error after the next one has started.
      if (disposed || utterance !== current) return;
      utterance = null; stop.hidden = true;
      status.textContent = error ? PR.t("朗读失败，请重试或检查系统语音") : localStatus();
    }
    function cancel() {
      if (utterance) {
        utterance = null;
        synth.cancel();
      }
      stop.hidden = true;
    }
    function speak(rate) {
      if (disposed) return;
      refreshVoices();
      if (!voice) return;
      cancel();
      const current = new Utterance(text);
      current.voice = voice; current.lang = voice.lang; current.rate = rate;
      current.onend = () => finish(current, false);
      current.onerror = () => finish(current, true);
      utterance = current; stop.hidden = false;
      status.textContent = PR.t("正在朗读…");
      try { synth.speak(current); }
      catch (_) { finish(current, true); }
    }
    normal.onclick = () => speak(1);
    slow.onclick = () => speak(0.75);
    stop.onclick = () => { cancel(); refreshVoices(); };
    accent.onchange = () => {
      cancel();
      PR.ls.set(preferenceKey, accent.value);
      refreshVoices(); // Changing an accent never starts playback.
    };
    voiceSelect.onchange = () => {
      cancel();
      PR.ls.set(voicePreference(), voiceSelect.value);
      refreshVoices();
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      synth.removeEventListener("voiceschanged", refreshVoices);
      window.removeEventListener("pagehide", dispose);
      normal.onclick = slow.onclick = stop.onclick = null;
      accent.onchange = null;
      voiceSelect.onchange = null;
    }
    synth.addEventListener("voiceschanged", refreshVoices);
    window.addEventListener("pagehide", dispose);
    refreshVoices();
    return { dispose };
  };
})(window.PR);
