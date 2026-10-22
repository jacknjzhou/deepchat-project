import { z } from 'zod'
import { TimestampMsSchema, defineEventContract } from '../common'

/** StaffDeck 连接配置已变更（保存/清除密钥后），renderer 应重新拉取员工列表。 */
export const digitalEmployeeConfigurationChangedEvent = defineEventContract({
  name: 'digitalEmployee.configurationChanged',
  payload: z.object({ changedAt: TimestampMsSchema })
})
