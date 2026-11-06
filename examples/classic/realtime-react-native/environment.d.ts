/// <reference types="expo/types" />

declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_REALTIME_TOKEN_URL?: string;
    EXPO_PUBLIC_REACT_NATIVE_E2E?: string;
  }
}
