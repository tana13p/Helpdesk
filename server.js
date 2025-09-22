require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const router = express.Router();
const { signIn, signUp } = require('./auth');
const { getConnection } = require('./dbconfig');
const oracledb = require('oracledb'); // make sure this is at the top
const multer = require('multer');
const path = require('path');
const upload = multer({ dest: 'uploads/' }); // store temporarily in /uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Make sure this folder exists
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const PDFDocument = require('pdfkit');


const app = express();
const PORT = 3000;
app.use(cors({
  origin: 'http://localhost:3000', // Or whatever port your frontend is served from
  credentials: true
}));
app.use('/uploads', express.static('uploads'));

const session = require('express-session');

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false,   // false for http, true if HTTPS
    sameSite: 'lax'  // or 'none' with secure: true for HTTPS
  }
}));

app.use(bodyParser.json());
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
app.get('/api/me', (req, res) => {
    console.log("📦 /api/me session:", req.session);  // <-- ADD THIS
  if (req.session.userId) {
    res.json({ userId: req.session.userId, username: req.session.username, role_id: req.session.role_id});
  } else {
    res.status(401).json({ message: 'Not authenticated' });
  }
});

app.post('/api/signin', async (req, res) => {
  console.log('🔍 Received sign-in request:', req.body);
  const { email, password } = req.body;
  const result = await signIn(email, password);

  if (result.success) {
    req.session.userId = result.user_id;
    req.session.username = result.username;
    req.session.role_id = result.role_id;
    console.log('🔐 Session object after login:', req.session);

    res.json({ success: true, message: result.message, role_id: result.role_id, username: result.username });
  } else {
    res.json({ success: false, message: result.message });
  }
});

app.post('/tickets', async (req, res) => {
  const { title, description, category_id, subcategory_id, priority_id, sla_id } = req.body;
  const created_by = req.session.userId;

  if (!created_by) {
    return res.status(401).json({ error: 'User not logged in' });
  }

  try {
    const connection = await getConnection();

    // Get SLA hours for deadlines
    const slaResult = await connection.execute(
      `SELECT RESPONSE_TIME_HOURS, RESOLUTION_TIME_HOURS FROM SLA_LEVELS WHERE SLA_LEVEL_ID = :sla_id`,
      { sla_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (slaResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid SLA ID' });
    }

    const responseDue = new Date(Date.now() + slaResult.rows[0].RESPONSE_TIME_HOURS * 60 * 60 * 1000);
    const resolutionDue = new Date(Date.now() + slaResult.rows[0].RESOLUTION_TIME_HOURS * 60 * 60 * 1000);

    const insertSql = `
      INSERT INTO tickets (
        TICKET_ID, TITLE, DESCRIPTION, CREATED_BY, CATEGORY_ID, SUBCATEGORY_ID,
        PRIORITY_ID, SLA_ID, RESPONSE_DUE, RESOLUTION_DUE,
        STATUS_ID, CREATED_AT, UPDATED_AT
      ) VALUES (
        ADMIN.ISEQ$$_73086.nextval, :title, :description, :created_by, :category_id, :subcategory_id,
        :priority_id, :sla_id, :response_due, :resolution_due,
        1, SYSDATE, SYSDATE
      )
    `;

    const bindParams = {
      title,
      description,
      created_by,
      category_id,
      subcategory_id: subcategory_id || null,
      priority_id,
      sla_id,
      response_due: responseDue,
      resolution_due: resolutionDue
    };

    await connection.execute(insertSql, bindParams, { autoCommit: true });

    res.status(201).json({ message: '✅ Ticket created successfully with SLA!' });

  } catch (err) {
    console.error('❌ Error while creating ticket:', err);
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

app.get('/tickets/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const connection = await getConnection();

    const result = await connection.execute(
      `SELECT * FROM tickets WHERE created_by = :userId ORDER BY created_at DESC`,
      { userId: Number(userId) }
    );

    const rows = result.rows;
    // Handle CLOBs (DESCRIPTION field)
    const parsedRows = await Promise.all(rows.map(async (row) => {
      // If DESCRIPTION is a LOB, convert it to string
      if (row.DESCRIPTION && typeof row.DESCRIPTION === 'object' && row.DESCRIPTION.constructor.name === 'Lob') {
        const clob = row.DESCRIPTION;
        return new Promise((resolve, reject) => {
          let clobData = '';
          clob.setEncoding('utf8');
          clob.on('data', chunk => clobData += chunk);
          clob.on('end', () => {
            row.DESCRIPTION = clobData;
            resolve(row);
          });
          clob.on('error', reject);
        });
      } else {
        return row;
      }
    }));

    console.log("Fetched rows:", parsedRows);
    res.json(parsedRows);
  } catch (err) {
    console.error('❌ Error while fetching tickets:', err);
    res.status(500).json({ error: 'Failed to fetch tickets.' });
  }
});

app.get('/assigned-tickets/:userId', async (req, res) => {
  const userId = req.params.userId;
  console.log('🔍 Fetching assigned tickets for userId:', userId);

  try {
    const connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         t.TICKET_ID,
         t.TITLE,
         t.DESCRIPTION,
         t.UPDATED_AT,
         t.CREATED_BY,
         t.ASSIGNED_TO,
         t.PRIORITY_ID,
         t.STATUS_ID,
         t.RESPONSE_DUE,
         t.RESOLUTION_DUE,
         t.CREATED_AT,
         t.TIME_WORKED,
         t.DUE_DATE,
         c.NAME AS CATEGORY_NAME,
         sc.NAME AS SUBCATEGORY_NAME,
         sla.NAME AS SLA_NAME,
         sla.RESPONSE_TIME_HOURS,
         sla.RESOLUTION_TIME_HOURS,
         u.USERNAME AS NAME,
         ts.STATUS_NAME AS STATUS,
         (
    SELECT u2.USERNAME
    FROM ticket_comments tc
    JOIN users u2 ON tc.commenter_id = u2.user_id
    WHERE tc.ticket_id = t.ticket_id
    ORDER BY tc.commented_at DESC
    FETCH FIRST 1 ROWS ONLY
  ) AS LAST_REPLIER
       FROM tickets t
       LEFT JOIN users u ON t.created_by = u.user_id
       LEFT JOIN ticket_status ts ON t.status_id = ts.status_id
       LEFT JOIN categories c ON t.category_id = c.category_id
       LEFT JOIN subcategories sc ON t.subcategory_id = sc.subcategory_id
       LEFT JOIN sla_levels sla ON t.sla_id = sla.sla_level_id
       WHERE t.assigned_to = :userId OR t.status_id = 1
       ORDER BY t.created_at DESC`,
      { userId: Number(userId) }
    );

    const rows = result.rows;

    // Handle CLOBs
    const parsedRows = await Promise.all(rows.map(async (row) => {
      if (row.DESCRIPTION && typeof row.DESCRIPTION === 'object' && row.DESCRIPTION.constructor.name === 'Lob') {
        const clob = row.DESCRIPTION;
        return new Promise((resolve, reject) => {
          let clobData = '';
          clob.setEncoding('utf8');
          clob.on('data', chunk => clobData += chunk);
          clob.on('end', () => {
            row.DESCRIPTION = clobData;
            resolve(row);
          });
          clob.on('error', reject);
        });
      } else {
        return row;
      }
    }));

    res.json(parsedRows);

  } catch (err) {
    console.error('❌ Error fetching assigned tickets:', err);
    res.status(500).json({ error: 'Failed to fetch assigned tickets.' });
  }
});

app.get('/ticket/:ticketId', async (req, res) => {
  const ticketId = req.params.ticketId;

  try {
    const connection = await getConnection();

    const result = await connection.execute(
      `SELECT t.*, 
              u1.username AS CREATED_BY_NAME, 
              u2.username AS AGENT_NAME,
              c.name AS CATEGORY_NAME, 
  sc.name AS SUBCATEGORY_NAME,  
  aa.level_id AS ASSIGNED_AGENT_LEVEL
       FROM tickets t
       LEFT JOIN users u1 ON t.created_by = u1.user_id
       LEFT JOIN users u2 ON t.assigned_to = u2.user_id
       LEFT JOIN categories c ON t.category_id = c.category_id
LEFT JOIN subcategories sc ON t.subcategory_id = sc.subcategory_id
       LEFT JOIN agent_assignment aa 
  ON aa.agent_id = t.assigned_to
WHERE t.ticket_id = :ticketId`,
      { ticketId: Number(ticketId) }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    let ticket = result.rows[0];

    // If DESCRIPTION is a CLOB, convert it to a string
    if (
      ticket.DESCRIPTION &&
      typeof ticket.DESCRIPTION === 'object' &&
      ticket.DESCRIPTION.constructor.name === 'Lob'
    ) {
      ticket = await new Promise((resolve, reject) => {
        let clobData = '';
        ticket.DESCRIPTION.setEncoding('utf8');
        ticket.DESCRIPTION.on('data', chunk => clobData += chunk);
        ticket.DESCRIPTION.on('end', () => {
          ticket.DESCRIPTION = clobData;
          resolve(ticket);
        });
        ticket.DESCRIPTION.on('error', reject);
      });
    }

    res.json(ticket);
  } catch (err) {
    console.error('❌ Error fetching single ticket:', err);
    res.status(500).json({ error: 'Failed to fetch ticket.' });
  }
});

app.post('/api/ticket/comment', upload.array('attachments'), async (req, res) => {
  const { ticketId, commentText, timeWorked } = req.body;
  const files = req.files;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: "User not authenticated" });
  }

  if (!ticketId || !commentText) {
    return res.status(400).json({ message: "Missing ticketId or commentText" });
  }

  try {
    const connection = await getConnection();
    // ✅ Save comment, timeWorked into DB
    const result = await connection.execute(
      `INSERT INTO ticket_comments (ticket_id,commenter_id, comment_text, commented_at) VALUES (:ticketId,:commenterId, :commentText, SYSDATE) RETURNING comment_id INTO :commentId`,
      { ticketId,commenterId: userId,commentText, commentId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
 },
      { autoCommit: true }
    );
     const commentId = result.outBinds.commentId[0];

    // ✅ Save each file's metadata into your attachments table
    for (const file of files) {
      await connection.execute(
        `INSERT INTO ticket_attachments (ticket_id, comment_id, file_name, file_path, uploaded_at) VALUES (:tid, :commentId, :fname, :fpath, SYSDATE)`,
        {
          tid: ticketId,
          commentId,
          fname: file.originalname,
          fpath: file.path // or move it and save a clean path
        },
        { autoCommit: true }
      );
    }
await connection.commit();
    await connection.close();
        console.log("✅ Comment saved with attachments:", files.length, "files");
    res.json({ message: "Comment and attachments saved." });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ message: "Failed to save comment or files." });
  }
});

app.get('/api/ticket/:ticketId/comments', async (req, res) => {
  const ticketId = req.params.ticketId;

  try {
    const conn = await getConnection();

    const result = await conn.execute(
      `SELECT tc.comment_id, tc.comment_text,  tc.commenter_id, tc.commented_at, u.username AS commenter_name, u.user_id AS commenter_id,
  u.role_id AS commenter_role_id
       FROM ticket_comments tc
       JOIN users u ON tc.commenter_id = u.user_id
       WHERE tc.ticket_id = :ticketId
       ORDER BY tc.commented_at ASC`,
      [ticketId],
      { outFormat: oracledb.OUT_FORMAT_OBJECT } // ✅ This is key
    );

    // Handle any CLOBs
    const rows = await Promise.all(result.rows.map(async comment => {
      if (comment.COMMENT_TEXT &&
          typeof comment.COMMENT_TEXT === 'object' &&
          comment.COMMENT_TEXT.constructor.name === 'Lob') {

        comment.COMMENT_TEXT = await new Promise((resolve, reject) => {
          let clobData = '';
          comment.COMMENT_TEXT.setEncoding('utf8');
          comment.COMMENT_TEXT.on('data', chunk => clobData += chunk);
          comment.COMMENT_TEXT.on('end', () => resolve(clobData));
          comment.COMMENT_TEXT.on('error', reject);
        });
      }
  const attachmentsResult = await conn.execute(
    `SELECT file_name, file_path FROM ticket_attachments WHERE comment_id = :commentId`,
    { commentId: comment.COMMENT_ID }
  );
  comment.ATTACHMENTS = attachmentsResult.rows;


      return comment;
    }));

    res.json(rows);

  } catch (err) {
    console.error("❌ Error fetching comments:", err);
    res.status(500).json({ message: "Failed to fetch comments" });
  }
});

app.put('/api/ticket/:ticketId/timeworked', async (req, res) => {
  const ticketId = req.params.ticketId;
  const { timeWorked } = req.body;

  if (!timeWorked || !/^\d{2}:\d{2}:\d{2}$/.test(timeWorked)) {
    return res.status(400).json({ message: "Invalid time format. Use HH:MM:SS." });
  }

  try {
    const connection = await getConnection();

    await connection.execute(
      `UPDATE tickets SET time_worked = :timeWorked, updated_at = SYSDATE WHERE ticket_id = :ticketId`,
      { timeWorked, ticketId: Number(ticketId) },
      { autoCommit: true }
    );

    res.json({ message: '✅ Time worked updated successfully.' });
  } catch (err) {
    console.error('❌ Error updating time worked:', err);
    res.status(500).json({ message: 'Failed to update time worked.' });
  }
});

app.put('/api/ticket/:ticketId/status', async (req, res) => {
  const ticketId = req.params.ticketId;
  const status = parseInt(req.body.status);
  const userId = req.session.userId;

  if (!status) {
    return res.status(400).json({ message: "Status is required" });
  }

  try {
    const connection = await getConnection();
    let query, params;

    if (parseInt(status) === 2) {
      // In Progress → Also assign the ticket to the current agent
      query = `
        UPDATE tickets 
        SET status_id = :status, assigned_to = :assignedTo, updated_at = CURRENT_TIMESTAMP
        WHERE ticket_id = :ticketId
      `;
      params = { status: parseInt(status), assignedTo: parseInt(userId), ticketId: parseInt(ticketId) };
    } else {
      // Just update the status
      query = `
        UPDATE tickets 
        SET status_id = :status, updated_at = CURRENT_TIMESTAMP
        WHERE ticket_id = :ticketId
      `;
      params = { status: parseInt(status), ticketId: parseInt(ticketId) };
    }
console.log("Parsed values →", { ticketId, status, userId, params });
if (isNaN(ticketId) || isNaN(status) || (status === 2 && isNaN(userId))) {
  return res.status(400).json({ message: "Invalid or missing values" });
}

    const result = await connection.execute(query, params, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json({ message: "Status updated successfully" });

  } catch (err) {
    console.error("❌ Error updating ticket status:", err);
    res.status(500).json({ message: "Server error" });
  }
});


app.put('/api/ticket/:ticketId/priority', async (req, res) => {
  const { ticketId } = req.params;
  const { priority } = req.body;

  const priorityMap = {
    "Low": 1,
    "Medium": 2,
    "High": 3,
    "Critical": 4
  };

  const priorityId = priorityMap[priority];
  if (!priorityId) return res.status(400).json({ message: "Invalid priority" });

  try {
    const connection = await getConnection();
    await connection.execute(
      `UPDATE tickets SET priority_id = :priorityId, updated_at = SYSDATE WHERE ticket_id = :ticketId`,
      { priorityId, ticketId: Number(ticketId) },
      { autoCommit: true }
    );

    res.json({ message: '✅ Priority updated.' });
  } catch (err) {
    console.error('❌ Error updating priority:', err);
    res.status(500).json({ message: 'Failed to update priority.' });
  }
});

app.get('/api/ticket/:ticketId/attachments', async (req, res) => {
  const ticketId = req.params.ticketId;

  try {
    const conn = await getConnection();
    const result = await conn.execute(
      `SELECT file_name, file_path FROM ticket_attachments WHERE ticket_id = :ticketId`,
      { ticketId }
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching attachments:", err);
    res.status(500).json({ message: "Failed to fetch attachments." });
  }
});

app.get('/api/knowledgebase', async (req, res) => {
  try {
    const connection = await getConnection();

    const result = await connection.execute(
      `SELECT * FROM KNOWLEDGE_BASE ORDER BY CREATED_AT DESC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rows = result.rows;

    // Convert CLOBs (problem_desc, solution_desc) to strings
    const parsedRows = await Promise.all(rows.map(async article => {
      // Handle PROBLEM_DESC
      if (
        article.PROBLEM_DESC &&
        typeof article.PROBLEM_DESC === 'object' &&
        article.PROBLEM_DESC.constructor.name === 'Lob'
      ) {
        article.PROBLEM_DESC = await new Promise((resolve, reject) => {
          let clobData = '';
          article.PROBLEM_DESC.setEncoding('utf8');
          article.PROBLEM_DESC.on('data', chunk => clobData += chunk);
          article.PROBLEM_DESC.on('end', () => resolve(clobData));
          article.PROBLEM_DESC.on('error', reject);
        });
      }

      // Handle SOLUTION_DESC
      if (
        article.SOLUTION_DESC &&
        typeof article.SOLUTION_DESC === 'object' &&
        article.SOLUTION_DESC.constructor.name === 'Lob'
      ) {
        article.SOLUTION_DESC = await new Promise((resolve, reject) => {
          let clobData = '';
          article.SOLUTION_DESC.setEncoding('utf8');
          article.SOLUTION_DESC.on('data', chunk => clobData += chunk);
          article.SOLUTION_DESC.on('end', () => resolve(clobData));
          article.SOLUTION_DESC.on('error', reject);
        });
      }

      return article;
    }));

    await connection.close();
    res.json(parsedRows);
  } catch (err) {
    console.error("❌ Error loading knowledge base:", err);
    res.status(500).json({ error: "Failed to load knowledge base" });
  }
});

app.get('/api/unavailability', async (req, res) => {
  try {
    const connection = await getConnection();

    const result = await connection.execute(`
      SELECT u.username AS username, cu.unavailable_date AS unavailable_date, cu.reason_desc AS reason_desc
      FROM calendar_unavailability cu
      JOIN users u ON cu.user_id = u.user_id
    `);

    const events = result.rows.map(row => ({
      title: row.REASON_DESC || 'Unavailable',
      start: row.UNAVAILABLE_DATE?.toISOString().split('T')[0],
      username: row.USERNAME
    }));

    await connection.close();
    return res.json(events);
  } catch (err) {
    console.error('Oracle error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/unavailability', async (req, res) => {
  const user = req.session.userId ? {
    user_id: req.session.userId,
    username: req.session.username
  } : null;

  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { date, reason } = req.body;

  if (!date) return res.status(400).json({ success: false, message: 'Date is required' });

  try {
    const connection = await getConnection();

    const check = await connection.execute(
      `SELECT COUNT(*) FROM calendar_unavailability 
       WHERE user_id = :1 AND unavailable_date = :2`,
      [user.user_id, new Date(date)]
    );

    if (check.rows[0][0] > 0) {
      await connection.close();
      return res.json({ success: false, message: 'Already marked' });
    }

    await connection.execute(
      `INSERT INTO calendar_unavailability (id, user_id, unavailable_date, reason_desc) 
       VALUES (CALENDAR_UNAVAILABILITY_SEQ.NEXTVAL, :1, :2, :3)`,
      [user.user_id, new Date(date), reason || 'Unavailable'],
      { autoCommit: true }
    );

    await connection.close();
    res.json({ success: true });

  } catch (err) {
    console.error("❌ Oracle insert error →", err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/all-tickets', async (req, res) => {
  const roleId = req.session.role_id;
  if (!req.session.userId || roleId !== 1) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const connection = await getConnection();

    const result = await connection.execute(`
      SELECT 
        t.TICKET_ID,
        t.TITLE,
        t.DESCRIPTION,
        t.STATUS_ID,
        s.STATUS_NAME AS STATUS,
        t.ASSIGNED_TO,
        a.USERNAME AS AGENT_NAME,
        t.PRIORITY_ID,
        t.RESPONSE_DUE,
        t.RESOLUTION_DUE,
        t.UPDATED_AT,
        t.CREATED_BY,
         t.CREATED_AT,
         t.TIME_WORKED,
         t.DUE_DATE,
        u.USERNAME AS NAME,
        lcu.USERNAME AS LAST_REPLIER,
        c.NAME AS CATEGORY_NAME,
        sc.NAME AS SUBCATEGORY_NAME,
        sla.NAME AS SLA_NAME,
        sla.RESPONSE_TIME_HOURS,
        sla.RESOLUTION_TIME_HOURS
      FROM tickets t
      LEFT JOIN users u ON t.CREATED_BY = u.USER_ID
      LEFT JOIN users a ON t.ASSIGNED_TO = a.USER_ID
      LEFT JOIN ticket_status s ON t.STATUS_ID = s.STATUS_ID
      LEFT JOIN categories c ON t.CATEGORY_ID = c.CATEGORY_ID
      LEFT JOIN subcategories sc ON t.SUBCATEGORY_ID = sc.SUBCATEGORY_ID
      LEFT JOIN sla_levels sla ON t.SLA_ID = sla.SLA_LEVEL_ID
      LEFT JOIN (
          SELECT tc.TICKET_ID, MAX(tc.COMMENTED_AT) AS latest_comment_time
          FROM ticket_comments tc
          GROUP BY tc.TICKET_ID
      ) lc ON t.TICKET_ID = lc.TICKET_ID
      LEFT JOIN ticket_comments last_com ON lc.TICKET_ID = last_com.TICKET_ID AND lc.latest_comment_time = last_com.COMMENTED_AT
      LEFT JOIN users lcu ON last_com.COMMENTER_ID = lcu.USER_ID
      ORDER BY t.UPDATED_AT DESC
    `);
const rows = result.rows;
// Handle CLOBs
    const parsedRows = await Promise.all(rows.map(async (row) => {
      if (row.DESCRIPTION && typeof row.DESCRIPTION === 'object' && row.DESCRIPTION.constructor.name === 'Lob') {
        const clob = row.DESCRIPTION;
        return new Promise((resolve, reject) => {
          let clobData = '';
          clob.setEncoding('utf8');
          clob.on('data', chunk => clobData += chunk);
          clob.on('end', () => {
            row.DESCRIPTION = clobData;
            resolve(row);
          });
          clob.on('error', reject);
        });
      } else {
        return row;
      }
    }));

    res.json(parsedRows);
  } catch (err) {
    console.error("❌ Admin all tickets error:", err);
    res.status(500).json({ message: "Database error" });
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const connection = await getConnection();
    const result = await connection.execute(
      `SELECT user_id, username AS name FROM users WHERE role_id = 2`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
    console.log("✅ Fetched agents:", result.rows);
  } catch (err) {
    console.error("❌ Error fetching agents:", err);
    res.status(500).json({ message: "Failed to fetch agents." });
  }
});

app.put('/api/ticket/:ticketId/assignee', async (req, res) => {
  const ticketId = req.params.ticketId;
  const { assignedTo } = req.body;

  try {
    const connection = await getConnection();
    await connection.execute(
      `UPDATE tickets SET assigned_to = :assignedTo, updated_at = SYSDATE WHERE ticket_id = :ticketId`,
      { assignedTo: Number(assignedTo), ticketId: Number(ticketId) },
      { autoCommit: true }
    );
    res.json({ message: '✅ Agent assigned successfully.' });
  } catch (err) {
    console.error('❌ Error assigning agent:', err);
    res.status(500).json({ message: 'Failed to assign agent.' });
  }
});

app.put('/api/ticket/:ticketId/duedate', async (req, res) => {
  const { ticketId } = req.params;
  const { dueDate } = req.body;

  try {
    const connection = await getConnection();

    // Convert to JS Date object
    const jsDueDate = new Date(dueDate);

    await connection.execute(
      `UPDATE tickets SET due_date = :dueDate WHERE ticket_id = :ticketId`,
      { dueDate: jsDueDate, ticketId: Number(ticketId) },
      { autoCommit: true }
    );

    res.json({ message: '✅ Due date updated successfully.' });
  } catch (err) {
    console.error('❌ Error updating due date:', err);
    res.status(500).json({ message: 'Failed to update due date.' });
  }
});

app.get('/api/tools/triggers', async (req, res) => {
  try {
    const connection = await getConnection();

    const result = await connection.execute(`
      SELECT 
        T.TRIGGER_NAME,
        T.STATUS,
        T.TABLE_NAME,
        M.DESCRIPTION
      FROM 
        USER_TRIGGERS T
      LEFT JOIN 
        TRIGGER_METADATA M
      ON 
        T.TRIGGER_NAME = M.TRIGGER_NAME
      ORDER BY 
        T.TRIGGER_NAME
    `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const triggers = result.rows.map(row => ({
  TRIGGER_NAME: row.TRIGGER_NAME,
  STATUS: row.STATUS,
  TABLE_NAME: row.TABLE_NAME,
  DESCRIPTION: row.DESCRIPTION || "No description available"
}));
console.log("Formatted Triggers to send:", triggers);
    await connection.close();
    res.json(triggers);
  } catch (err) {
    console.error("❌ Failed to fetch trigger metadata:", err);
    res.status(500).send("Server Error");
  }
});

app.post('/api/tools/trigger/toggle', async (req, res) => {
  const { triggerName, enable } = req.body;
  if (!triggerName) return res.status(400).send("Trigger name required.");

  const action = enable ? 'ENABLE' : 'DISABLE';
  try {
    const connection = await getConnection();
    await connection.execute(`ALTER TRIGGER ${triggerName} ${action}`);
    await connection.commit();
    await connection.close();

    res.json({ message: `✅ Trigger ${action}D successfully.` });
  } catch (err) {
    console.error("❌ Error toggling trigger:", err);
    res.status(500).send("Could not toggle trigger.");
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.execute(
      `SELECT CATEGORY_ID, NAME FROM categories ORDER BY NAME`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching categories:", err);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

app.get('/api/subcategories', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.execute(
      `SELECT SUBCATEGORY_ID, NAME, CATEGORY_ID FROM subcategories ORDER BY NAME`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching subcategories:", err);
    res.status(500).json({ message: "Failed to fetch subcategories" });
  }
});

app.get('/api/sla-levels', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.execute(
      `SELECT SLA_LEVEL_ID, NAME, RESPONSE_TIME_HOURS, RESOLUTION_TIME_HOURS FROM sla_levels ORDER BY SLA_LEVEL_ID`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching SLA levels:", err);
    res.status(500).json({ message: "Failed to fetch SLA levels" });
  }
});

app.post('/api/ticket/:ticketId/escalate', async (req, res) => {
  const { ticketId } = req.params;
    try {
const conn = await getConnection();
    const result = await conn.execute(
`BEGIN escalate_ticket(:ticketId); END;`, 
      { ticketId: Number(ticketId) },
      { autoCommit: true }
    );
    res.json({ message: 'Escalation triggered. DB will reassign automatically.' });
  } catch (err) {
    console.error('❌ Escalation trigger failed:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.put('/api/knowledgebase/:id', async (req, res) => {
  const id = req.params.id;
  const { title, problem_desc, solution_desc } = req.body;

  if (!title || !problem_desc || !solution_desc) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const connection = await getConnection();

    await connection.execute(
      `UPDATE KNOWLEDGE_BASE 
       SET TITLE = :title, PROBLEM_DESC = :problem_desc, SOLUTION_DESC = :solution_desc 
       WHERE ID = :id`,
      {
        id,
        title,
        problem_desc,
        solution_desc
      },
      { autoCommit: true }
    );

    await connection.close();
    res.json({ message: "Knowledge base entry updated" });
  } catch (err) {
    console.error("❌ Error updating knowledge base:", err);
    res.status(500).json({ error: "Failed to update article" });
  }
});
app.post('/api/knowledgebase', async (req, res) => {
  const { title, problem_desc, solution_desc, category } = req.body;

  if (!title || !problem_desc || !solution_desc || !category) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const connection = await getConnection();

    const result = await connection.execute(
      `INSERT INTO KNOWLEDGE_BASE (TITLE, CATEGORY, PROBLEM_DESC, SOLUTION_DESC, CREATED_AT)
       VALUES (:title, :category, :problem_desc, :solution_desc, SYSDATE)`,
      {
        title,
        category,
        problem_desc,
        solution_desc
      },
      { autoCommit: true }
    );

    await connection.close();
    res.status(201).json({ message: "Knowledge base entry created" });
  } catch (err) {
    console.error("❌ Error creating knowledge base entry:", err);
    res.status(500).json({ error: "Failed to create article" });
  }
});
app.delete('/api/knowledgebase/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const connection = await getConnection();

    const result = await connection.execute(
      `DELETE FROM KNOWLEDGE_BASE WHERE ID = :id`,
      { id },
      { autoCommit: true }
    );

    await connection.close();

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json({ message: "Knowledge base entry deleted" });
  } catch (err) {
    console.error("❌ Error deleting knowledge base entry:", err);
    res.status(500).json({ error: "Failed to delete article" });
  }
});

app.use(express.static('public'));

// Add user endpoint for admin
app.post('/api/admin/add-user', async (req, res) => {
  if (!req.session.userId || req.session.role_id !== 1) {
    return res.status(403).json({ success: false, message: 'Forbidden: Admins only' });
  }
  const { username, email, password, role_id } = req.body;
  if (!username || !email || !password || !role_id) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  try {
    // Use signUp logic, but allow custom role_id
    const { getConnection } = require('./dbconfig');
    const bcrypt = require('bcrypt');
    const connection = await getConnection();
    const password_hash = await bcrypt.hash(password, 10);
    await connection.execute(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES (:username, :email, :password_hash, :role_id)`,
      { username, email, password_hash, role_id },
      { autoCommit: true }
    );
    await connection.close();
    res.json({ success: true, message: 'User created successfully' });
  } catch (err) {
    if (err && err.errorNum === 1) {
      // ORA-00001: unique constraint violated
      res.status(409).json({ success: false, message: 'User with this email already exists.' });
    } else {
      console.error('❌ Error creating user:', err);
      res.status(500).json({ success: false, message: 'Failed to create user.' });
    }
  }
});

// Reports summary endpoint for admin
app.get('/api/reports/summary', async (req, res) => {
  if (!req.session.userId || req.session.role_id !== 1) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const connection = await getConnection();
    // Total tickets
    const totalResult = await connection.execute('SELECT COUNT(*) AS TOTAL FROM tickets');
    // Open tickets (status_id = 1)
    const openResult = await connection.execute('SELECT COUNT(*) AS OPEN FROM tickets WHERE status_id = 1');
    // Resolved tickets (status_id = 3)
    const resolvedResult = await connection.execute('SELECT COUNT(*) AS RESOLVED FROM tickets WHERE status_id = 3');
    // SLA breaches (response_due < SYSDATE and status_id not resolved/closed)
    const slaResult = await connection.execute('SELECT COUNT(*) AS SLA_BREACHES FROM tickets WHERE response_due < SYSDATE AND status_id NOT IN (3,4)');
    await connection.close();
    res.json({
      totalTickets: totalResult.rows[0].TOTAL,
      openTickets: openResult.rows[0].OPEN,
      resolvedTickets: resolvedResult.rows[0].RESOLVED,
      slaBreaches: slaResult.rows[0].SLA_BREACHES
    });
  } catch (err) {
    console.error('❌ Error fetching report summary:', err);
    res.status(500).json({ message: 'Failed to fetch report summary' });
  }
});

// Agent-wise performance report endpoint for admin
app.get('/api/reports/agents', async (req, res) => {
  if (!req.session.userId || req.session.role_id !== 1) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const connection = await getConnection();
    // Get all agents
    const agentsResult = await connection.execute(`
      SELECT user_id, username FROM users WHERE role_id = 2
    `);
    const agents = agentsResult.rows;
    const report = [];
    for (const agent of agents) {
      const agentId = agent.USER_ID;
      const agentName = agent.USERNAME;
      // Assigned tickets
      const assignedResult = await connection.execute(
        `SELECT COUNT(*) AS ASSIGNED FROM tickets WHERE assigned_to = :agentId`,
        { agentId }
      );
      // Resolved tickets
      const resolvedResult = await connection.execute(
        `SELECT COUNT(*) AS RESOLVED FROM tickets WHERE assigned_to = :agentId AND status_id = 3`,
        { agentId }
      );
      // Average response time (in hours)
      const avgResponseResult = await connection.execute(
        `SELECT AVG((response_due - created_at) * 24) AS AVG_RESPONSE_HRS FROM tickets WHERE assigned_to = :agentId AND response_due IS NOT NULL AND created_at IS NOT NULL`,
        { agentId }
      );
      // Average resolution time (in hours)
      const avgResolutionResult = await connection.execute(
        `SELECT AVG((resolution_due - created_at) * 24) AS AVG_RESOLUTION_HRS FROM tickets WHERE assigned_to = :agentId AND resolution_due IS NOT NULL AND created_at IS NOT NULL`,
        { agentId }
      );
      // SLA breaches
      const slaBreachesResult = await connection.execute(
        `SELECT COUNT(*) AS SLA_BREACHES FROM tickets WHERE assigned_to = :agentId AND response_due < SYSDATE AND status_id NOT IN (3,4)`,
        { agentId }
      );
      report.push({
        agentId,
        agentName,
        assignedTickets: assignedResult.rows[0].ASSIGNED,
        resolvedTickets: resolvedResult.rows[0].RESOLVED,
        avgResponseTime: avgResponseResult.rows[0].AVG_RESPONSE_HRS ? Number(avgResponseResult.rows[0].AVG_RESPONSE_HRS).toFixed(2) : null,
        avgResolutionTime: avgResolutionResult.rows[0].AVG_RESOLUTION_HRS ? Number(avgResolutionResult.rows[0].AVG_RESOLUTION_HRS).toFixed(2) : null,
        slaBreaches: slaBreachesResult.rows[0].SLA_BREACHES
      });
    }
    await connection.close();
    res.json(report);
  } catch (err) {
    console.error('❌ Error fetching agent report:', err);
    res.status(500).json({ message: 'Failed to fetch agent report' });
  }
});

app.get('/api/reports/agent/:id/pdf', async (req, res) => {
  const agentId = parseInt(req.params.id);
  if (!req.session.userId || req.session.role_id !== 1) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const connection = await getConnection();
    // Get agent info
    const agentResult = await connection.execute(
      'SELECT username FROM users WHERE user_id = :id',
      { id: agentId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (agentResult.rows.length === 0) {
      await connection.close();
      return res.status(404).json({ message: 'Agent not found' });
    }
    const agentName = agentResult.rows[0].USERNAME;
    // Get stats
    const [assignedResult, resolvedResult, avgResponseResult, avgResolutionResult, slaBreachesResult] = await Promise.all([
      connection.execute('SELECT COUNT(*) AS ASSIGNED FROM tickets WHERE assigned_to = :agentId', { agentId }),
      connection.execute('SELECT COUNT(*) AS RESOLVED FROM tickets WHERE assigned_to = :agentId AND status_id = 3', { agentId }),
      connection.execute('SELECT AVG((response_due - created_at) * 24) AS AVG_RESPONSE_HRS FROM tickets WHERE assigned_to = :agentId AND response_due IS NOT NULL AND created_at IS NOT NULL', { agentId }),
      connection.execute('SELECT AVG((resolution_due - created_at) * 24) AS AVG_RESOLUTION_HRS FROM tickets WHERE assigned_to = :agentId AND resolution_due IS NOT NULL AND created_at IS NOT NULL', { agentId }),
      connection.execute('SELECT COUNT(*) AS SLA_BREACHES FROM tickets WHERE assigned_to = :agentId AND response_due < SYSDATE AND status_id NOT IN (3,4)', { agentId })
    ]);
    await connection.close();
    // Prepare stats
    const stats = {
      assignedTickets: assignedResult.rows[0].ASSIGNED,
      resolvedTickets: resolvedResult.rows[0].RESOLVED,
      avgResponseTime: avgResponseResult.rows[0].AVG_RESPONSE_HRS ? Number(avgResponseResult.rows[0].AVG_RESPONSE_HRS).toFixed(2) : 'N/A',
      avgResolutionTime: avgResolutionResult.rows[0].AVG_RESOLUTION_HRS ? Number(avgResolutionResult.rows[0].AVG_RESOLUTION_HRS).toFixed(2) : 'N/A',
      slaBreaches: slaBreachesResult.rows[0].SLA_BREACHES
    };
    // Generate PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=agent_report_${agentId}.pdf`);
    const doc = new PDFDocument();
    doc.pipe(res);
    doc.fontSize(22).text(`Agent Performance Report`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text(`Agent: ${agentName}`);
    doc.moveDown();
    doc.fontSize(13).text(`Total Tickets Assigned: ${stats.assignedTickets}`);
    doc.text(`Tickets Resolved: ${stats.resolvedTickets}`);
    doc.text(`Average Response Time (hrs): ${stats.avgResponseTime}`);
    doc.text(`Average Resolution Time (hrs): ${stats.avgResolutionTime}`);
    doc.text(`SLA Breaches: ${stats.slaBreaches}`);
    doc.end();
  } catch (err) {
    console.error('❌ Error generating agent PDF report:', err);
    res.status(500).json({ message: 'Failed to generate PDF report' });
  }
});

app.post('/api/reports/dashboard-pdf', async (req, res) => {
  try {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const { summary, charts } = JSON.parse(body);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=dashboard_report.pdf');
      const doc = new PDFDocument({ margin: 36 });
      doc.pipe(res);
      // Title
      doc.fontSize(22).text('Service Desk Dashboard Report', { align: 'center' });
      doc.moveDown(1.5);
      // Summary cards
      const cardWidth = 130, cardHeight = 70, gap = 18;
      let x = doc.page.margins.left, y = doc.y;
      summary.forEach((card, i) => {
        doc.save();
        doc.roundedRect(x, y, cardWidth, cardHeight, 10).fillAndStroke(card.color || '#f5f5f5', '#e0e0e0');
        doc.fillColor('#fff').fontSize(12).text(card.title, x + 12, y + 12, { width: cardWidth - 24 });
        doc.fontSize(22).text(card.value, x + 12, y + 30, { width: cardWidth - 24 });
        doc.fontSize(10).fillColor('#f5f5f5').text(card.subtitle, x + 12, y + 56, { width: cardWidth - 24 });
        doc.restore();
        x += cardWidth + gap;
      });
      doc.moveDown(4);
      // Charts
      for (const chart of charts) {
        doc.addPage();
        doc.fontSize(16).fillColor('#05386B').text(chart.title, { align: 'center' });
        doc.moveDown(0.5);
        // Embed chart image
        const base64 = chart.image.split(',')[1];
        const imgBuffer = Buffer.from(base64, 'base64');
        doc.image(imgBuffer, { fit: [450, 250], align: 'center', valign: 'center' });
        doc.moveDown(1.5);
      }
      doc.end();
    });
  } catch (err) {
    console.error('❌ Error generating dashboard PDF:', err);
    res.status(500).json({ message: 'Failed to generate dashboard PDF' });
  }
});

// --- Admin Settings CRUD Endpoints ---

// Middleware: admin only
function requireAdmin(req, res, next) {
  console.log('🔐 requireAdmin middleware - userId:', req.session.userId, 'role_id:', req.session.role_id);
  if (!req.session.userId || req.session.role_id !== 1) {
    console.log('❌ Access denied: not admin');
    return res.status(403).json({ message: 'Forbidden' });
  }
  console.log('✅ Admin access granted');
  next();
}

// ---- CATEGORIES ----
app.get('/api/settings/categories', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    const result = await connection.execute('SELECT CATEGORY_ID, NAME, DESCRIPTION FROM CATEGORIES ORDER BY CATEGORY_ID');
    await connection.close();
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch categories' });
  }
});
app.post('/api/settings/categories', requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ message: 'Name required' });
  try {
    const connection = await getConnection();
    await connection.execute(
      'INSERT INTO CATEGORIES (CATEGORY_ID, NAME, DESCRIPTION) VALUES (ISEQ$$_74264.NEXTVAL, :name, :description)',
      { name, description }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Category added' });
  } catch (err) {
    console.error('❌ Error adding category:', err);
    res.status(500).json({ message: 'Failed to add category' });
  }
});
app.put('/api/settings/categories/:id', requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  try {
    const connection = await getConnection();
    await connection.execute(
      'UPDATE CATEGORIES SET NAME = :name, DESCRIPTION = :description WHERE CATEGORY_ID = :id',
      { name, description, id: req.params.id }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Category updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update category' });
  }
});
app.delete('/api/settings/categories/:id', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    await connection.execute('DELETE FROM CATEGORIES WHERE CATEGORY_ID = :id', { id: req.params.id }, { autoCommit: true });
    await connection.close();
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete category' });
  }
});

// ---- SUBCATEGORIES ----
app.get('/api/settings/subcategories', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    const result = await connection.execute('SELECT SUBCATEGORY_ID, CATEGORY_ID, NAME, DESCRIPTION FROM SUBCATEGORIES ORDER BY SUBCATEGORY_ID');
    await connection.close();
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch subcategories' });
  }
});
// SUBCATEGORIES: use ISEQ$$_74265.NEXTVAL
app.post('/api/settings/subcategories', requireAdmin, async (req, res) => {
  const { category_id, name, description } = req.body;
  if (!category_id || !name) return res.status(400).json({ message: 'Category and name required' });
  try {
    const connection = await getConnection();
    await connection.execute(
      'INSERT INTO SUBCATEGORIES (SUBCATEGORY_ID, CATEGORY_ID, NAME, DESCRIPTION) VALUES (ISEQ$$_74267.NEXTVAL, :category_id, :name, :description)',
      { category_id, name, description }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Subcategory added' });
  } catch (err) {
    console.error('❌ Error adding subcategory:', err);
    res.status(500).json({ message: 'Failed to add subcategory' });
  }
});
app.put('/api/settings/subcategories/:id', requireAdmin, async (req, res) => {
  const { category_id, name, description } = req.body;
  try {
    const connection = await getConnection();
    await connection.execute(
      'UPDATE SUBCATEGORIES SET CATEGORY_ID = :category_id, NAME = :name, DESCRIPTION = :description WHERE SUBCATEGORY_ID = :id',
      { category_id, name, description, id: req.params.id }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Subcategory updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update subcategory' });
  }
});
app.delete('/api/settings/subcategories/:id', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    await connection.execute('DELETE FROM SUBCATEGORIES WHERE SUBCATEGORY_ID = :id', { id: req.params.id }, { autoCommit: true });
    await connection.close();
    res.json({ message: 'Subcategory deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete subcategory' });
  }
});

// ---- SLA LEVELS ----
app.get('/api/settings/sla', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    const result = await connection.execute('SELECT SLA_LEVEL_ID, NAME, DESCRIPTION, RESPONSE_TIME_HOURS, RESOLUTION_TIME_HOURS FROM SLA_LEVELS ORDER BY SLA_LEVEL_ID');
    await connection.close();
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch SLA levels' });
  }
});
// SLA_LEVELS: use ISEQ$$_74266.NEXTVAL
app.post('/api/settings/sla', requireAdmin, async (req, res) => {
  const { name, description, response_time_hours, resolution_time_hours } = req.body;
  if (!name) return res.status(400).json({ message: 'Name required' });
  try {
    const connection = await getConnection();
    const result = await connection.execute('SELECT NVL(MAX(SLA_LEVEL_ID), 0) + 1 AS NEXT_ID FROM SLA_LEVELS');
    const nextId = result.rows[0].NEXT_ID;
    await connection.execute(
      'INSERT INTO SLA_LEVELS (SLA_LEVEL_ID, NAME, DESCRIPTION, RESPONSE_TIME_HOURS, RESOLUTION_TIME_HOURS) VALUES (:id, :name, :description, :response_time_hours, :resolution_time_hours)',
      { id: nextId, name, description, response_time_hours, resolution_time_hours }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'SLA level added' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to add SLA level' });
  }
});
app.put('/api/settings/sla/:id', requireAdmin, async (req, res) => {
  const { name, description, response_time_hours, resolution_time_hours } = req.body;
  try {
    const connection = await getConnection();
    await connection.execute(
      'UPDATE SLA_LEVELS SET NAME = :name, DESCRIPTION = :description, RESPONSE_TIME_HOURS = :response_time_hours, RESOLUTION_TIME_HOURS = :resolution_time_hours WHERE SLA_LEVEL_ID = :id',
      { name, description, response_time_hours, resolution_time_hours, id: req.params.id }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'SLA level updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update SLA level' });
  }
});
app.delete('/api/settings/sla/:id', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    await connection.execute('DELETE FROM SLA_LEVELS WHERE SLA_LEVEL_ID = :id', { id: req.params.id }, { autoCommit: true });
    await connection.close();
    res.json({ message: 'SLA level deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete SLA level' });
  }
});

// ---- ROLES ----
app.get('/api/settings/roles', requireAdmin, async (req, res) => {
  try {
    const connection = await getConnection();
    const result = await connection.execute('SELECT ROLE_ID, ROLE_NAME FROM ROLES ORDER BY ROLE_ID');
    await connection.close();
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch roles' });
  }
});
// ROLES: use ISEQ$$_74267.NEXTVAL
app.post('/api/settings/roles', requireAdmin, async (req, res) => {
  const { role_name } = req.body;
  if (!role_name) return res.status(400).json({ message: 'Role name required' });
  try {
    const connection = await getConnection();
    await connection.execute(
      'INSERT INTO ROLES (ROLE_ID, ROLE_NAME) VALUES (ISEQ$$_74267.NEXTVAL, :role_name)',
      { role_name }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Role added' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to add role' });
  }
});
app.put('/api/settings/roles/:id', requireAdmin, async (req, res) => {
  const { role_name } = req.body;
  try {
    const connection = await getConnection();
    await connection.execute(
      'UPDATE ROLES SET ROLE_NAME = :role_name WHERE ROLE_ID = :id',
      { role_name, id: req.params.id }, { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Role updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update role' });
  }
});
app.delete('/api/settings/roles/:id', requireAdmin, async (req, res) => {
  console.log('🗑️ Attempting to delete role ID:', req.params.id);
  try {
    const connection = await getConnection();
    console.log('✅ Database connection established');
    
    // Check if role is being used by any users
    console.log('🔍 Checking if role is used by users...');
    const userCheck = await connection.execute('SELECT COUNT(*) as user_count FROM USERS WHERE ROLE_ID = :id', { id: req.params.id });
    console.log('👥 Users with this role:', userCheck.rows[0].USER_COUNT);
    
    if (userCheck.rows[0].USER_COUNT > 0) {
      await connection.close();
      console.log('❌ Cannot delete: role is assigned to users');
      return res.status(400).json({ message: 'Cannot delete role: it is assigned to users' });
    }
    
    console.log('🗑️ Proceeding with role deletion...');
    const result = await connection.execute('DELETE FROM ROLES WHERE ROLE_ID = :id', { id: req.params.id }, { autoCommit: true });
    console.log('📊 Rows affected:', result.rowsAffected);
    await connection.close();
    console.log('✅ Database connection closed');
    
    if (result.rowsAffected === 0) {
      console.log('❌ Role not found in database');
      return res.status(404).json({ message: 'Role not found' });
    }
    
    console.log('✅ Role deleted successfully');
    res.json({ message: 'Role deleted successfully' });
  } catch (err) {
    console.error('❌ Error deleting role:', err);
    res.status(500).json({ message: 'Failed to delete role: ' + err.message });
  }
});

// --- USER PROFILE ENDPOINTS ---
app.get('/api/profile', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ message: 'Not authenticated' });
  try {
    const connection = await getConnection();
    const result = await connection.execute(
      'SELECT user_id, username, email, role_id FROM users WHERE user_id = :userId',
      { userId: req.session.userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    await connection.close();
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error fetching profile:', err);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
});

app.put('/api/profile', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ message: 'Not authenticated' });
  const { username, email } = req.body;
  if (!username || !email) return res.status(400).json({ message: 'Missing fields' });
  try {
    const connection = await getConnection();
    await connection.execute(
      'UPDATE users SET username = :username, email = :email WHERE user_id = :userId',
      { username, email, userId: req.session.userId },
      { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Profile updated' });
  } catch (err) {
    console.error('❌ Error updating profile:', err);
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// --- CHANGE PASSWORD ENDPOINT ---
app.post('/api/change-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ message: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Missing fields' });
  try {
    const connection = await getConnection();
    const result = await connection.execute(
      'SELECT password_hash FROM users WHERE user_id = :userId',
      { userId: req.session.userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (result.rows.length === 0) {
      await connection.close();
      return res.status(404).json({ message: 'User not found' });
    }
    const bcrypt = require('bcrypt');
    const match = await bcrypt.compare(currentPassword, result.rows[0].PASSWORD_HASH);
    if (!match) {
      await connection.close();
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await connection.execute(
      'UPDATE users SET password_hash = :newHash WHERE user_id = :userId',
      { newHash, userId: req.session.userId },
      { autoCommit: true }
    );
    await connection.close();
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('❌ Error changing password:', err);
    res.status(500).json({ message: 'Failed to change password' });
  }
});

// Agent-specific summary stats
app.get('/api/reports/agent/:id/summary', async (req, res) => {
  const agentId = parseInt(req.params.id);
  if (!req.session.userId || req.session.role_id !== 1) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const connection = await getConnection();
    // Total tickets assigned
    const totalResult = await connection.execute('SELECT COUNT(*) AS TOTAL FROM tickets WHERE assigned_to = :agentId', { agentId });
    // Open tickets
    const openResult = await connection.execute('SELECT COUNT(*) AS OPEN FROM tickets WHERE assigned_to = :agentId AND status_id = 1', { agentId });
    // Resolved tickets
    const resolvedResult = await connection.execute('SELECT COUNT(*) AS RESOLVED FROM tickets WHERE assigned_to = :agentId AND status_id = 3', { agentId });
    // SLA compliance
    const slaTotal = await connection.execute('SELECT COUNT(*) AS TOTAL FROM tickets WHERE assigned_to = :agentId AND sla_id IS NOT NULL', { agentId });
    const slaMet = await connection.execute('SELECT COUNT(*) AS MET FROM tickets WHERE assigned_to = :agentId AND sla_id IS NOT NULL AND response_due >= updated_at', { agentId });
    // Avg response/resolution time
    const avgResponse = await connection.execute('SELECT AVG((response_due - created_at) * 24) AS AVG_RESPONSE_HRS FROM tickets WHERE assigned_to = :agentId AND response_due IS NOT NULL AND created_at IS NOT NULL', { agentId });
    const avgResolution = await connection.execute('SELECT AVG((resolution_due - created_at) * 24) AS AVG_RESOLUTION_HRS FROM tickets WHERE assigned_to = :agentId AND resolution_due IS NOT NULL AND created_at IS NOT NULL', { agentId });
    // CSAT (dummy for now)
    const csat = 4.6;
    await connection.close();
    res.json({
      totalTickets: totalResult.rows[0].TOTAL,
      openTickets: openResult.rows[0].OPEN,
      resolvedTickets: resolvedResult.rows[0].RESOLVED,
      slaCompliance: slaTotal.rows[0].TOTAL ? Math.round((slaMet.rows[0].MET / slaTotal.rows[0].TOTAL) * 100) : 0,
      avgResponseTime: avgResponse.rows[0].AVG_RESPONSE_HRS ? Number(avgResponse.rows[0].AVG_RESPONSE_HRS).toFixed(2) : 'N/A',
      avgResolutionTime: avgResolution.rows[0].AVG_RESOLUTION_HRS ? Number(avgResolution.rows[0].AVG_RESOLUTION_HRS).toFixed(2) : 'N/A',
      csat
    });
  } catch (err) {
    console.error('❌ Error fetching agent summary:', err);
    res.status(500).json({ message: 'Failed to fetch agent summary' });
  }
});

// Agent-specific chart data
app.get('/api/reports/agent/:id/charts', async (req, res) => {
  const agentId = parseInt(req.params.id);
  if (!req.session.userId || req.session.role_id !== 1) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const connection = await getConnection();
    // Ticket volume over time (by month)
    const volumeResult = await connection.execute(
      `SELECT TO_CHAR(created_at, 'Mon') AS MONTH, COUNT(*) AS COUNT
       FROM tickets WHERE assigned_to = :agentId GROUP BY TO_CHAR(created_at, 'Mon'), TO_NUMBER(TO_CHAR(created_at, 'MM'))
       ORDER BY TO_NUMBER(TO_CHAR(created_at, 'MM'))`,
      { agentId }
    );
    // Status distribution
    const statusResult = await connection.execute(
      `SELECT status_id, COUNT(*) AS COUNT FROM tickets WHERE assigned_to = :agentId GROUP BY status_id`,
      { agentId }
    );
    // Priority distribution
    const priorityResult = await connection.execute(
      `SELECT priority_id, COUNT(*) AS COUNT FROM tickets WHERE assigned_to = :agentId GROUP BY priority_id`,
      { agentId }
    );
    // SLA compliance over time (dummy)
    const slaResult = { labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], data: [91,90,89,92,93,91,90,89,92,93,91,90] };
    // Tickets by category
    const categoryResult = await connection.execute(
      `SELECT c.name AS CATEGORY, COUNT(*) AS COUNT FROM tickets t LEFT JOIN categories c ON t.category_id = c.category_id WHERE assigned_to = :agentId GROUP BY c.name`,
      { agentId }
    );
    // CSAT (dummy)
    const csat = 4.6;
    await connection.close();
    res.json({
      ticketVolume: volumeResult.rows,
      statusDist: statusResult.rows,
      priorityDist: priorityResult.rows,
      slaCompliance: slaResult,
      categoryDist: categoryResult.rows,
      csat
    });
  } catch (err) {
    console.error('❌ Error fetching agent charts:', err);
    res.status(500).json({ message: 'Failed to fetch agent charts' });
  }
});
