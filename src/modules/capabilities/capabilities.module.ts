import { Module } from "@nestjs/common";

import { HmacKeyringService } from "./hmac-keyring.service.js";

/** Provides rotation-aware HMAC operations without exposing key material. */
@Module({ providers: [HmacKeyringService], exports: [HmacKeyringService] })
export class CapabilitiesModule {}
