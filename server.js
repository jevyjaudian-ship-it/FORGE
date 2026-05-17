require('dotenv').config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());


const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    }
});

db.connect((err) => {
    if (err) {
        console.error("Cloud Database connection failed:", err.message);
        return;
    }
    console.log("Connected to Aiven MySQL Cloud!");
});

app.get("/services", (req, res) => {
    db.query("SELECT * FROM service", (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result);
    });
});


app.get("/staff", (req, res) => {
    db.query("SELECT * FROM staff", (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result);
    });
});

app.get("/my-appointments/:customerId", (req, res) => {
    const customerId = req.params.customerId;
    const sql = `
        SELECT a.appointment_date as date, a.start_time, s.full_name as staff_name, a.status 
        FROM appointment a 
        JOIN staff s ON a.staff_id = s.staff_id 
        WHERE a.customer_id = ?
        ORDER BY a.appointment_date DESC`;
        
    db.query(sql, [customerId], (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result);
    });
});

// 1. GET ALL APPOINTMENTS (For the Admin Table)
// 1. GET ALL APPOINTMENTS (Updated with Clean Date and No Nulls)
app.get("/admin/appointments", (req, res) => {
    const sql = `
        SELECT a.appointment_id, c.name as customer_name, s.full_name as staff_name, 
               DATE_FORMAT(a.appointment_date, '%M %d, %Y') as formatted_date, 
               a.start_time, a.status,
               IFNULL((SELECT SUM(price) FROM service srv 
                JOIN appointment_services aps ON srv.service_id = aps.service_id 
                WHERE aps.appointment_id = a.appointment_id), 0) as total_price
        FROM appointment a
        JOIN customer c ON a.customer_id = c.customer_id
        JOIN staff s ON a.staff_id = s.staff_id
        ORDER BY a.appointment_date DESC`;
    
    db.query(sql, (err, result) => {
        if (err) {
            console.error("SQL Error:", err); // This will tell you if the SQL is wrong
            return res.status(500).send(err);
        }
        res.json(result);
    });
});

// 2. GET DASHBOARD STATS (Fixed Revenue math)
// GET ADMIN DASHBOARD STATS
app.get("/admin/stats", (req, res) => {
    const statsSql = `
        SELECT 
            /* 1. Calculate Total Revenue from all CONFIRMED appointments */
            IFNULL((
                SELECT SUM(srv.price) 
                FROM service srv 
                JOIN appointment_services aps ON srv.service_id = aps.service_id 
                JOIN appointment a ON aps.appointment_id = a.appointment_id 
                WHERE a.status = 'Confirmed'
            ), 0) as total_revenue,

            /* 2. Find the Staff Member with the most bookings */
            (
                SELECT s.full_name 
                FROM staff s 
                JOIN appointment a ON s.staff_id = a.staff_id 
                GROUP BY s.staff_id 
                ORDER BY COUNT(a.appointment_id) DESC 
                LIMIT 1
            ) as top_staff,

            /* 3. Count how many appointments are still waiting for approval */
            (
                SELECT COUNT(*) 
                FROM appointment 
                WHERE status = 'Pending'
            ) as pending_count
    `;

    db.query(statsSql, (err, result) => {
        if (err) {
            console.error("Stats Query Error:", err);
            return res.status(500).json({ success: false, message: "Database error" });
        }

        // Send the data back to the Admin Panel
        res.json({
            today_revenue: result[0].total_revenue, // We keep the name 'today_revenue' so your frontend JS doesn't have to change
            top_staff: result[0].top_staff || "No Bookings Yet",
            pending_count: result[0].pending_count
        });
    });
});
// 3. UPDATE APPOINTMENT STATUS (Confirm/Cancel)
app.post("/admin/update-status", (req, res) => {
    const { appointment_id, status } = req.body;
    const sql = "UPDATE appointment SET status = ? WHERE appointment_id = ?";
    db.query(sql, [status, appointment_id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.json({ success: true });
    });
});


app.post("/appointment", (req, res) => {
    // We added 'time' here to match what the checkout page sends
    const { customer_id, staff_id, date, time, start_time } = req.body;
    
    // Use 'time' if 'start_time' is missing
    const finalTime = time || start_time;

    const sql = "INSERT INTO appointment (customer_id, staff_id, appointment_date, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'Pending')";
    
    db.query(sql, [customer_id, staff_id, date, finalTime, finalTime], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ appointment_id: result.insertId });
    });
});

app.post("/appointment/services", (req, res) => {
    const { appointment_id, services } = req.body;
    
   
    const values = services.map(s => [appointment_id, s.service_id]);
    const sql = "INSERT INTO appointment_services (appointment_id, service_id) VALUES ?";

    db.query(sql, [values], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Services added!" });
    });
});

app.post("/login", (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM customer WHERE email = ? AND password = ?";
    
    db.query(sql, [email, password], (err, result) => {
        if (err) return res.status(500).json(err);

        if (result.length > 0) {
            const user = result[0];
            res.json({ 
                success: true, 
                customer_id: user.customer_id, 
                name: user.name,
                email: user.email,
                role: user.role // <--- SEND THE ROLE (admin or user)
            });
        } else {
            res.json({ success: false, message: "Invalid credentials" });
        }
    });
});

// REGISTER ROUTE
app.post("/register", (req, res) => {
    const { name, phone_num, email, password } = req.body;

    // Check if email already exists
    const checkSql = "SELECT * FROM customer WHERE email = ?";
    db.query(checkSql, [email], (err, result) => {
        if (result.length > 0) {
            return res.json({ success: false, message: "Email already registered!" });
        }

        // If new, insert into database
        // We use NOW() for the date_created column
        const sql = "INSERT INTO customer (name, phone_num, email, password, date_created) VALUES (?, ?, ?, ?, NOW())";
        
        db.query(sql, [name, phone_num, email, password], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: "Database error" });
            }
            res.json({ success: true, message: "User registered!" });
        });
    });
});

// ADD NEW SERVICE
app.post("/admin/add-service", (req, res) => {
    const { service_name, description, price, duration } = req.body;
    const sql = "INSERT INTO service (service_name, description, price, duration) VALUES (?, ?, ?, ?)";
    db.query(sql, [service_name, description, price, duration], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ success: true, message: "Service added!" });
    });
});

// ADD NEW STAFF
app.post("/admin/add-staff", (req, res) => {
    const { full_name, specialization, phone_number } = req.body;
    const sql = "INSERT INTO staff (full_name, specialization, phone_number, hire_date, status) VALUES (?, ?, ?, CURDATE(), 'Active')";
    db.query(sql, [full_name, specialization, phone_number], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ success: true, message: "Staff member added!" });
    });
});

// RECORD PAYMENT
app.post("/appointment/payment", (req, res) => {
    const { appointment_id, amount, payment_method } = req.body;
    
    // Default status is 'Paid' for online or 'Pending' for Cash
    const status = (payment_method === 'Cash') ? 'Pending' : 'Paid';

    const sql = `INSERT INTO payment (appointment_id, payment_date, amount, payment_method, payment_status) 
                 VALUES (?, NOW(), ?, ?, ?)`;
    
    db.query(sql, [appointment_id, amount, payment_method, status], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});