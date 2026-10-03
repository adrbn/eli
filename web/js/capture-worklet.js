// Le micro capté sur le fil audio : il ne perd plus de bouts quand la page est occupée (l'ancien ScriptProcessor,
// sur le fil principal, sautait des morceaux de phrase dès qu'elle ramait, et la transcription devenait du charabia).
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const x = inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      this.buf[this.n++] = x[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
