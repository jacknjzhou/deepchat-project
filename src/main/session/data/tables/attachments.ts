import { BaseTable } from '@/data/baseTable'
import type Database from 'better-sqlite3-multiple-ciphers'

/**
 * 旧版附件元数据表：记录每条消息携带的附件（类型/文件名/存储方式/缩略图等）。
 * 主键自增 id，attach_id 唯一，按 message_id 外键级联删除。
 * 属于 conversations/messages 旧版消息体系；新版消息的附件走
 * deepchat_user_message_files。仅建表，无其它读写方法。
 */
export class AttachmentsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'attachments')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attach_id TEXT UNIQUE NOT NULL,
        message_id TEXT NOT NULL,
        attachment_type TEXT NOT NULL CHECK(attachment_type IN ('file', 'image', 'code', 'audio', 'video')),
        file_name TEXT NOT NULL,
        file_size INTEGER,
        storage_type TEXT NOT NULL CHECK(storage_type IN ('path', 'blob', 'cloud')),
        storage_path TEXT,
        thumbnail BLOB,
        vectorized INTEGER DEFAULT 0,
        data_summary TEXT,
        mime_type TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_attachment_type ON attachments(attachment_type);
      CREATE INDEX idx_attachment_vector ON attachments(vectorized);
    `
  }

  getMigrationSQL(): string | null {
    return null
  }

  getLatestVersion(): number {
    return 0
  }
}
