import { Controller, Get, Param } from '@nestjs/common';
import { PortainerService } from './portainer.service';

@Controller('containers')
export class PortainerController {
    constructor(private readonly portainerService: PortainerService) { }

    @Get()
    async getContainers() {
        return this.portainerService.getContainers();
    }

    @Get(':containerId')
    async getContainerLogs(
        @Param('containerId') containerId: string,
    ) {
        return this.portainerService.getContainer(containerId);
    }
}
