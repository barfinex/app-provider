import { Module } from '@nestjs/common';
import { PortainerService } from './portainer.service';
import { PortainerController } from './portainer.controller';

@Module({
    providers: [PortainerService],
    controllers: [PortainerController],
})
export class PortainerModule { }
