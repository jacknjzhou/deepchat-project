import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { DocumentTasksTable } from './tables/documentTasks'
import { DocumentTemplatesTable } from './tables/documentTemplates'
import { DocumentsTable } from './tables/documents'
import { WatchedFilesTable } from './tables/watchedFiles'

export class DocumentsDatabase {
  constructor(private readonly connection: DatabaseConnectionProvider) {
    // Documents tables are normally created by the startup diagnosis/repair path, which
    // only rebuilds missing tables and cannot migrate in-place constraint changes. Ensure
    // the tasks and documents tables lose their legacy source CHECK and the watch table
    // exists on both fresh and existing installs. Idempotent on every subsequent
    // construction.
    const db = this.getDatabase()
    db.transaction(() => {
      new DocumentTasksTable(db).ensureMigrated()
      new DocumentsTable(db).ensureMigrated()
      new WatchedFilesTable(db).createTable()
    })()
  }

  getDatabase() {
    return this.connection.getDatabase()
  }

  get documentTemplatesTable(): DocumentTemplatesTable {
    return new DocumentTemplatesTable(this.getDatabase())
  }

  get documentsTable(): DocumentsTable {
    return new DocumentsTable(this.getDatabase())
  }

  get documentTasksTable(): DocumentTasksTable {
    return new DocumentTasksTable(this.getDatabase())
  }

  get watchedFilesTable(): WatchedFilesTable {
    return new WatchedFilesTable(this.getDatabase())
  }
}
