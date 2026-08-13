import type { MeeseekApi } from "../shared/api";

declare global {
  interface Window {
    meeseek: MeeseekApi;
  }
}

export {};
