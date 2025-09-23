import { Controller, Get } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionController {

    constructor(
        private subscriptionSecvice: SubscriptionService
    ) {

    }

    @Get()
    async all() {
        return this.subscriptionSecvice.getAll();
    }
}
