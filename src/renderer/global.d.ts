import type { MeezeekApi } from "../shared/api";

declare global {
  interface Window {
    meezeek: MeezeekApi;
  }
}

export {};
