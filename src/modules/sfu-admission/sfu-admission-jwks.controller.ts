import { Controller, Get, Header, Req, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";

import { SfuAdmissionJwksDto } from "./sfu-admission.dto.js";
import { SfuAdmissionKeyService } from "./sfu-admission-key.service.js";

/** Public RFC 7517 key-discovery boundary consumed by SFU verifier nodes. */
@ApiTags("sfu")
@Controller("v1/sfu-admission")
export class SfuAdmissionJwksController {
  public constructor(private readonly keys: SfuAdmissionKeyService) {}

  /** Serves current plus retired public keys with bounded caching and strong ETags. */
  @Get("jwks.json")
  @Header("cache-control", "public, max-age=60, must-revalidate")
  @Header("content-type", "application/jwk-set+json")
  @ApiOperation({ summary: "Publish SFU admission verification keys" })
  @ApiOkResponse({ type: SfuAdmissionJwksDto })
  @ApiResponse({ status: 304, description: "The cached JWKS is still current." })
  public get(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): SfuAdmissionJwksDto | undefined {
    const document = this.keys.jwks();
    void reply.header("etag", document.etag);
    if (request.headers["if-none-match"] === document.etag) {
      void reply.status(304);
      return undefined;
    }
    return document.body;
  }
}
