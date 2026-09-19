/** JWT media type fixed by the SFU verifier contract. */
export const SFU_ADMISSION_TOKEN_TYPE = "sfu-admission+jwt";
/** JWT purpose claim preventing cross-use with session or realtime credentials. */
export const SFU_ADMISSION_TOKEN_USE = "sfu_admission";
/** Only asymmetric algorithm emitted by the backend admission service. */
export const SFU_ADMISSION_ALGORITHM = "EdDSA";

/** Exact permission vocabulary implemented by the independent SFU. */
export const SFU_PERMISSIONS = [
  "room:join",
  "transport:create:send",
  "transport:create:recv",
  "media:produce:audio",
  "media:produce:video",
  "media:consume",
  "data:produce",
  "data:consume",
  "e2ee:enable",
  "room:moderate",
  "recording:manage",
] as const;

/** Permission understood and independently enforced by the SFU. */
export type SfuPermission = (typeof SFU_PERMISSIONS)[number];
