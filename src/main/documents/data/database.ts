import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { DocumentTasksTable } from './tables/documentTasks'
import { DocumentTemplatesTable } from './tables/documentTemplates'
import { DocumentsTable } from './tables/documents'

export class DocumentsDatabase {
  constructor(private readonly connection: DatabaseConnectionProvider) {}

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
}
