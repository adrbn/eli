// Écoute permanente : découpe ce que capte le micro en bouts de phrase, que le serveur examine (« Eli, … » ?).
// Un bout commence quand le niveau dépasse nettement le bruit de fond, et finit après un court silence.
export const PRE = 0.3, TAIL = 0.6, MAX = 6, MIN = 0.25, MARGIN = 0.18;

export class Segmenter {
  constructor(rate, onSegment) {
    this.rate = rate;
    this.onSegment = onSegment;
    this.floor = 0.3; // niveau du bruit de fond (0..1, comme Mic.level)
    this.pre = []; // les derniers blocs avant le début : la première syllabe n'est pas coupée
    this.cur = null;
    this.quiet = 0;
  }

  push(x, level) {
    const dt = x.length / this.rate;
    // Le fond suit aussitôt ce qui est plus calme, et remonte lentement (une pièce qui devient bruyante).
    this.floor = level < this.floor ? level : this.floor + 0.02 * dt;
    const loud = level > this.floor + MARGIN;
    if (!this.cur) {
      this.pre.push(x.slice());
      while (this.pre.length * dt > PRE) this.pre.shift();
      if (loud) {
        this.cur = this.pre;
        this.pre = [];
        this.quiet = 0;
      }
      return;
    }
    this.cur.push(x.slice());
    this.quiet = loud ? 0 : this.quiet + dt;
    const dur = this.cur.length * dt;
    if (this.quiet >= TAIL || dur >= MAX) {
      const seg = this.cur;
      this.cur = null;
      if (dur - this.quiet - PRE >= MIN) this.onSegment(seg);
    }
  }

  reset() {
    this.cur = null;
    this.pre = [];
  }
}
