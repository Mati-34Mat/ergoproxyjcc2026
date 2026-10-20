import pg from 'pg'
import { splitAnswerByHeadings } from './lib/tree/split-answer.ts'

const dry = process.argv.includes('--dry')
const c = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED })
await c.connect()
const { rows: shared } = await c.query(`select "messageId" from question_nodes where "messageId" is not null
  group by "messageId" having count(*) > 1`)
for (const { messageId } of shared) {
  const { rows: [msg] } = await c.query(`select * from messages where id = $1`, [messageId])
  const { rows: nodes } = await c.query(`select id, question, "answerSummary" from question_nodes
    where "messageId" = $1 order by "createdAt", id`, [messageId])
  const { rows: [userMsg] } = await c.query(`select id from messages where "nodeId" = $1 and role = 'user'
    and seq < $2 order by seq desc limit 1`, [msg.nodeId, msg.seq])
  const parts = splitAnswerByHeadings(msg.content, nodes.map((n) => n.question))
  console.log(messageId, nodes.map((n) => n.question), parts ? 'split' : 'SKIP', userMsg ? '' : 'no user msg')
  if (!parts || !userMsg || !msg.nodeId || dry) continue
  await c.query('begin')
  try {
    await c.query(`update messages set content = $2 where id = $1`, [msg.id, parts[0]])
    const { rows: [{ n: siblings }] } = await c.query(
      `select count(*)::int n from conversation_nodes where "parentId" = $1`, [msg.nodeId])
    for (let i = 1; i < nodes.length; i++) {
      const { rows: [branch] } = await c.query(`insert into conversation_nodes
        ("conversationId","userId","parentId","anchorMessageId",alias,topic,position)
        values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [msg.conversationId, msg.userId, msg.nodeId, userMsg.id, nodes[i].question,
         nodes[i].answerSummary || nodes[i].question, siblings + i - 1])
      const { rows: [reply] } = await c.query(`insert into messages
        ("conversationId","userId",role,content,description,metadata,"nodeId","createdAt")
        values ($1,$2,'assistant',$3,$4,$5,$6,$7) returning id`,
        [msg.conversationId, msg.userId, parts[i], nodes[i].answerSummary ?? msg.description,
         msg.metadata, branch.id, msg.createdAt])
      await c.query(`update question_nodes set "messageId" = $2 where id = $1`, [nodes[i].id, reply.id])
    }
    await c.query('commit')
  } catch (e) { await c.query('rollback'); throw e }
}
await c.end()
