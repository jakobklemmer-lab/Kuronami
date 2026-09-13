/**
 * Mikrofon rein, Stimme raus — das einzige Stück der Sprachschicht, das den Browser braucht.
 *
 * Bewusst getrennt von `session.ts`: dort steht das Protokoll und ist ohne Browser prüfbar, hier
 * stehen `getUserMedia`, `AudioContext` und `AudioWorklet` und sind es nicht. Was sich nicht
 * prüfen lässt, soll wenigstens klein und an einer Stelle sein.
 *
 * **Warum ein AudioWorklet und kein `ScriptProcessorNode`:** letzterer läuft im Haupt-Thread und
 * ist seit Jahren abgekündigt; eine Sprachaufnahme, die bei jedem Neuzeichnen der Oberfläche
 * stockt, wäre am Sprachkanal kein Schönheitsfehler, sondern ein abgeschnittenes Wort. Das
 * Worklet wird als Blob eingebunden, weil `ui/` ohne Bundler ausgeliefert wird (S29) und eine
 * zweite Datei im Auslieferungspfad eine zweite Stelle wäre, die stimmen muss.
 *
 * **Abtastraten.** Der `AudioContext` wird mit der Rate erzeugt, die die Pipeline genannt hat
 * (`ready`), statt umgekehrt umzurechnen: der Browser kann den Kontext in der Zielrate fahren,
 * und eine eigene Neuabtastung wäre Arbeit, die irgendwann falsch klingt. Ein- und Ausgabe
 * bekommen deshalb **zwei** Kontexte — die Pipeline hört mit 16 kHz und spricht mit 24 kHz.
 */

/** Das Worklet: nimmt Fließkomma-Blöcke entgegen und schickt 16-Bit-PCM an den Haupt-Thread. */
const CAPTURE_WORKLET = `
class KuronamiCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor("kuronami-capture", KuronamiCapture);
`;

export interface MicrophoneHandle {
  stop(): Promise<void>;
}

export interface MicrophoneOptions {
  sampleRate: number;
  onChunk: (pcm: ArrayBuffer) => void;
}

/** Öffnet das Mikrofon und liefert 16-Bit-PCM-Blöcke. Wirft, wenn der Nutzer ablehnt. */
export async function startMicrophone(options: MicrophoneOptions): Promise<MicrophoneHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Die drei Aufbereitungen des Browsers bleiben **an**. Sie sind genau das, was ein
      // Barge-in braucht: ohne Echounterdrückung hörte das VAD die eigene Stimme des Agenten
      // aus dem Lautsprecher und unterbräche sich selbst, endlos.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new AudioContext({ sampleRate: options.sampleRate });
  const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
  const moduleUrl = URL.createObjectURL(blob);
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "kuronami-capture");
  worklet.port.onmessage = (event) => options.onChunk(event.data as ArrayBuffer);
  source.connect(worklet);
  // Der Knoten muss an ein Ziel, sonst zieht ihn manche Engine gar nicht erst durch. Ein
  // stummer Gain-Knoten davor verhindert, dass das Mikrofon im Lautsprecher landet.
  const mute = context.createGain();
  mute.gain.value = 0;
  worklet.connect(mute).connect(context.destination);

  return {
    async stop(): Promise<void> {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close();
    },
  };
}

export interface SpeakerHandle {
  play(pcm: ArrayBuffer): void;
  /** Wirft weg, was noch in der Schlange steht. Genau das ist Barge-in auf der Hörerseite. */
  flush(): void;
  close(): Promise<void>;
}

/**
 * Spielt die ankommenden PCM-Blöcke lückenlos hintereinander ab.
 *
 * Die Schlange ist der Grund, warum `flush` existiert: die Pipeline hört bei einer Unterbrechung
 * sofort auf zu senden, aber was schon im Browser liegt, wäre noch zu hören — und der Agent
 * redete eine halbe Sekunde über den Nutzer hinweg. `flush` ist die Hörerseite desselben
 * Handgriffs, den `base_output` in Pipecat auf der Senderseite macht.
 */
export function createSpeaker(sampleRate: number): SpeakerHandle {
  const context = new AudioContext({ sampleRate });
  let playAt = 0;
  let sources: AudioBufferSourceNode[] = [];

  return {
    play(pcm: ArrayBuffer): void {
      const samples = new Int16Array(pcm);
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const now = context.currentTime;
      playAt = Math.max(playAt, now);
      source.start(playAt);
      playAt += buffer.duration;
      sources.push(source);
      source.onended = () => {
        sources = sources.filter((entry) => entry !== source);
      };
    },

    flush(): void {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // Schon gelaufen oder nie gestartet — beides heißt: nichts mehr zu stoppen.
        }
      }
      sources = [];
      playAt = context.currentTime;
    },

    async close(): Promise<void> {
      this.flush();
      await context.close();
    },
  };
}
