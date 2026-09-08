import { Module } from "@nestjs/common";
import { InternalNewsController, NewsController } from "./news.controller";
import { NewsService } from "./news.service";

@Module({
  controllers: [NewsController, InternalNewsController],
  providers: [NewsService],
})
export class NewsModule {}
