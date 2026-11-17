import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { EmployeeGuard } from './guards/employee.guard.js';
import { JobSearchDiagnosticsMiddleware } from './job-search.diagnostics.js';

@Module({
  imports: [NotificationsModule],
  controllers: [JobsController],
  providers: [JobsService, EmployeeGuard],
})
export class JobsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(JobSearchDiagnosticsMiddleware).forRoutes({
      path: 'jobs/search',
      method: RequestMethod.GET,
    });
  }
}
