import type { TETApi } from "../shared/api";

declare global {
  interface Window {
    tet: TETApi;
  }
}

export {};
