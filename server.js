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
         ts.STATUS_NAME AS STATUS
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
              u2.username AS AGENT_NAME 
       FROM tickets t
       LEFT JOIN users u1 ON t.created_by = u1.user_id
       LEFT JOIN users u2 ON t.assigned_to = u2.user_id
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
      `INSERT INTO calendar_unavailability (user_id, unavailable_date, reason_desc) 
       VALUES (:1, :2, :3)`,
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
        t.STATUS_ID,
        s.STATUS_NAME AS STATUS,
        t.ASSIGNED_TO,
        a.USERNAME AS AGENT_NAME,
        t.PRIORITY_ID,
        t.RESPONSE_DUE,
        t.RESOLUTION_DUE,
        t.UPDATED_AT,
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
    `, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    console.log("✅ Raw result rows:", result.rows);
    await connection.close();
    res.json(result.rows);

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

app.use(express.static('public'));
