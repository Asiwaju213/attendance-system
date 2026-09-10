# OOU Attendance System

A production-minded university attendance management system for Olabisi Onabanjo University (OOU). This system will manage student attendance tracking, lecturer workflows, course management, and administrative reporting.

## Technology Stack

| Layer       | Technology                          |
| ----------- | ----------------------------------- |
| Frontend    | React + TypeScript (Vite)           |
| Backend     | Node.js + Express.js + TypeScript   |
| Database    | PostgreSQL                          |
| API Style   | REST                                |
| Testing     | Playwright                          |
| Package Mgr | npm                                 |

## Project Structure

```
attendance-system/
├── frontend/          # React + TypeScript client application
├── backend/           # Express.js + TypeScript API server
├── database/          # Database schemas and migrations (coming soon)
├── docs/              # Project documentation
└── README.md
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- npm (comes with Node.js)

### Installation

Clone the repository and install dependencies for both the frontend and backend:

```bash
# Clone the repository
git clone <repository-url>
cd attendance-system

# Install frontend dependencies
cd frontend
npm install

# Install backend dependencies
cd ../backend
npm install
```

### Running the Frontend

```bash
cd frontend
npm run dev
```

The frontend will start on `http://localhost:5173` by default.

### Running the Backend

```bash
cd backend
npm run dev
```

The backend will start on `http://localhost:5000`. It uses `tsx watch` to automatically restart when source files change.

### Health Check

Once the backend is running, verify it is healthy:

```
GET http://localhost:5000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "message": "OOU Attendance System API is running",
  "timestamp": "2026-09-10T..."
}
```

## Database

PostgreSQL setup, schema design, and migrations will be added in a future step. The `database/` directory is reserved for that purpose.

## License

This project is for educational purposes at Olabisi Onabanjo University.
