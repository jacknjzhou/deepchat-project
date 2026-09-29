import { createDocumentsClient } from './DocumentsClient'
import type { documentTaskSchema } from '@shared/contracts/routes'
import type { z } from 'zod'

export type DocumentsTaskItem = z.infer<typeof documentTaskSchema>

// Stateless bridge wrapper shared by the store (default client) and the
// archive page (task event subscription) so there is exactly one instance.
export const documentsApi = createDocumentsClient()
