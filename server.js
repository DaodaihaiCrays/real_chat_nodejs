
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(__dirname + '/public'));

const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) {
        console.error('Lỗi kết nối cơ sở dữ liệu:', err.message);
    } else {
        console.log('Đã kết nối với cơ sở dữ liệu SQLite.');
    }
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            password TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user1_id INTEGER,
            user2_id INTEGER,
            FOREIGN KEY (user1_id) REFERENCES users(id),
            FOREIGN KEY (user2_id) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER,
            sender_id INTEGER,
            message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id),
            FOREIGN KEY (sender_id) REFERENCES users(id)
        )
    `);
});

// API lấy danh sách người dùng, loại trừ người dùng hiện tại
app.get('/users', (req, res) => {
    const excludeUserId = req.query.excludeUserId;
    db.all(`SELECT id, username FROM users WHERE id != ?`, [excludeUserId], (err, rows) => {
        if (err) {
            res.status(500).send('Lỗi khi lấy danh sách người dùng');
        } else {
            res.status(200).json(rows);
        }
    });
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], (err) => {
        if (err) {
            res.status(500).send('Lỗi khi đăng ký');
        } else {
            res.status(200).send('Đăng ký thành công');
        }
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) {
            res.status(401).send('Tên đăng nhập hoặc mật khẩu sai');
        } else {
            res.status(200).json({ userId: row.id, username: row.username });
        }
    });
});

// Lắng nghe kết nối từ client qua Socket.IO
io.on('connection', (socket) => {
    console.log('Người dùng đã kết nối', socket.id);  // In ra console khi có người dùng kết nối tới server bằng socket

    // Lắng nghe sự kiện "start conversation" từ client
    socket.on('start conversation', ({ user1_id, user2_id }) => {
        // Truy vấn cơ sở dữ liệu SQLite để kiểm tra xem có cuộc trò chuyện nào giữa user1 và user2 chưa
        db.get(`SELECT * FROM conversations WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)`, 
        [user1_id, user2_id, user2_id, user1_id], (err, conversation) => {
            if (err) {
                // Nếu có lỗi khi truy vấn, gửi thông báo lỗi về phía client
                socket.emit('error', 'Lỗi khi tìm cuộc trò chuyện');
            } else if (!conversation) {
                // Nếu không có cuộc trò chuyện nào giữa user1 và user2, tạo một cuộc trò chuyện mới
                db.run(`INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)`, [user1_id, user2_id], function(err) {
                    if (err) {
                        // Nếu có lỗi khi tạo cuộc trò chuyện, gửi thông báo lỗi về phía client
                        socket.emit('error', 'Lỗi khi tạo cuộc trò chuyện mới');
                    } else {
                        // Nếu cuộc trò chuyện được tạo thành công, gửi cuộc trò chuyện mới về phía client
                        const conversation_id = this.lastID;  // Lấy ID của cuộc trò chuyện mới được tạo
                        socket.emit('conversation started', { conversation_id });  // Gửi ID của cuộc trò chuyện về phía client
                        loadOldMessages(socket, conversation_id);  // Gửi các tin nhắn cũ của cuộc trò chuyện này
                    }
                });
            } else {
                // Nếu cuộc trò chuyện đã tồn tại, gửi ID của cuộc trò chuyện về phía client
                const conversation_id = conversation.id;
                socket.emit('conversation started', { conversation_id });  // Gửi ID của cuộc trò chuyện đã tồn tại về phía client
                loadOldMessages(socket, conversation_id);  // Gửi các tin nhắn cũ của cuộc trò chuyện này
            }
        });
    });

    // Lắng nghe sự kiện "chat message" từ client (khi người dùng gửi tin nhắn)
    // Mỗi khi server nhận được tin nhắn từ client, nó sẽ phát tin nhắn đó tới tất cả các client trong phòng 
    // conversation_id, tức là tất cả những người tham gia cuộc trò chuyện 
    //sẽ nhận được tin nhắn mới ngay lập tức.
    socket.on('chat message', ({ conversation_id, sender_id, message }) => {
        // Lưu tin nhắn mới vào cơ sở dữ liệu với ID của cuộc trò chuyện và ID của người gửi
        db.run(`INSERT INTO messages (conversation_id, sender_id, message) VALUES (?, ?, ?)`, [conversation_id, sender_id, message], (err) => {
            if (err) {
                console.error('Lỗi khi lưu tin nhắn:', err.message);  // Nếu có lỗi khi lưu tin nhắn, in lỗi ra console
            } else {
                // Nếu tin nhắn được lưu thành công, phát tin nhắn đó tới tất cả các client trong cuộc trò chuyện này
                io.to(conversation_id).emit('chat message', { conversation_id, sender_id, message });
            }
        });
    });

    // Lắng nghe sự kiện "join conversation" từ client (khi người dùng tham gia vào cuộc trò chuyện)
    socket.on('join conversation', (conversation_id) => {
        socket.join(conversation_id);  // Thêm người dùng vào phòng của cuộc trò chuyện (phòng là conversation_id)
        console.log(`Người dùng ${socket.id} đã tham gia cuộc trò chuyện ${conversation_id}`);  // In ra console khi người dùng tham gia vào cuộc trò chuyện
    });

    // Lắng nghe sự kiện "disconnect" khi người dùng ngắt kết nối
    socket.on('disconnect', () => {
        console.log('Người dùng đã ngắt kết nối', socket.id);  // In ra console khi người dùng ngắt kết nối khỏi server
    });
});

// Hàm này lấy tất cả các tin nhắn cũ trong cuộc trò chuyện và gửi về phía client
function loadOldMessages(socket, conversation_id) {
    db.all(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`, [conversation_id], (err, rows) => {
        if (err) {
            console.error('Lỗi khi truy vấn tin nhắn cũ:', err.message);  // Nếu có lỗi khi truy vấn tin nhắn cũ, in lỗi ra console
        } else {
            // Nếu truy vấn thành công, gửi tất cả tin nhắn cũ về phía client
            socket.emit('load old messages', rows);
        }
    });
}


server.listen(3000, () => {
    console.log('Server đang chạy trên http://localhost:3000');
});
