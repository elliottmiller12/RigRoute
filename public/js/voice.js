// Voice in/out using the browser's built-in speech APIs. No audio touches our
// server. Note: Chrome's recognizer sends audio to Google's speech service;
// Safari's runs on Apple's. Typed prompts work everywhere.

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const voiceSupported = !!SR;

/**
 * Listen once. Calls onInterim(text) as words come in; resolves with the final text ('' if nothing).
 */
export function listenOnce({ onInterim, lang = 'en-US', maxMs = 15000 } = {}) {
  if (!SR) return Promise.reject(new Error('Voice input isn’t supported in this browser. Type it instead.'));
  return new Promise((resolve, reject) => {
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = '';
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, maxMs);
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (onInterim) onInterim((finalText + interim).trim());
    };
    rec.onerror = (ev) => finish(() => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') resolve('');
      else if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') reject(new Error('Mic access is blocked. Allow the microphone for this site, or type it.'));
      else reject(new Error('Didn’t catch that. Try again or type it.'));
    });
    rec.onend = () => finish(() => resolve(finalText.trim()));
    try { rec.start(); } catch (e) { finish(() => reject(e)); }
    listenOnce.stop = () => { try { rec.stop(); } catch { /* ignore */ } };
  });
}

/** Short spoken readback so the driver doesn't have to look at the screen. */
export function speak(text) {
  const s = globalThis.speechSynthesis;
  if (!s || !text) return;
  try {
    s.cancel();
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
    u.rate = 1.05;
    s.speak(u);
  } catch { /* ignore */ }
}
