export class ExhaustSwitchError extends Error {
  constructor(x: never) {
    super(`Unreachable case: ${JSON.stringify(x)}`);
    Object.setPrototypeOf(this, ExhaustSwitchError.prototype);
  }
}
