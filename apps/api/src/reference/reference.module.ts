import { Module } from "@nestjs/common";
import { InternalReferenceController, ReferenceController } from "./reference.controller";
import { ReferenceService } from "./reference.service";

@Module({
  controllers: [ReferenceController, InternalReferenceController],
  providers: [ReferenceService],
})
export class ReferenceModule {}
