import type { MeeseexApi } from "../shared/api";

declare global {
  interface Window {
    meeseex: MeeseexApi;
  }
}

export {};
