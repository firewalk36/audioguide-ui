// @ts-check
/**
 * Minimal observable state container. No dependency on the DOM, so it is
 * safe to import anywhere (including tests).
 * @template T
 */
export class Store {
  /** @param {T} initial */
  constructor(initial) {
    /** @type {T} */
    this.state = initial;
    /** @type {Set<(state: T, prev: T) => void>} */
    this._subs = new Set();
  }

  /** @returns {T} */
  getState() {
    return this.state;
  }

  /**
   * Shallow-merge a patch into state and notify subscribers.
   * @param {Partial<T>|((state: T) => Partial<T>)} patch
   */
  setState(patch) {
    const prev = this.state;
    const delta = typeof patch === "function" ? patch(prev) : patch;
    this.state = { ...prev, ...delta };
    for (const fn of this._subs) fn(this.state, prev);
  }

  /**
   * @param {(state: T, prev: T) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}
