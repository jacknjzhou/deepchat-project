import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { ResumeScreeningResumesTable } from './tables/resumeScreeningResumes'
import { ResumeScreeningTasksTable } from './tables/resumeScreeningTasks'

export class ResumeScreeningDatabase {
  constructor(private readonly connection: DatabaseConnectionProvider) {}

  getDatabase() {
    return this.connection.getDatabase()
  }

  get tasksTable(): ResumeScreeningTasksTable {
    return new ResumeScreeningTasksTable(this.getDatabase())
  }

  get resumesTable(): ResumeScreeningResumesTable {
    return new ResumeScreeningResumesTable(this.getDatabase())
  }
}
