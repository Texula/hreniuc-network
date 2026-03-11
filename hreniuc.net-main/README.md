# The official code used by Hreniuc Network website at:
https://www.hreniuc.net

The application supports public chat, private messaging, friend systems, voice channels, and persistent message history.  
It was designed and implemented as a custom communication platform focusing on real-time networking, backend architecture, and security best practices.

## Features

### Real-Time Communication
- WebSocket-based real-time messaging
- Public and private chat channels
- Tab-based chat interface
- Live online user list

### Voice Channels
- Peer-to-peer voice communication using WebRTC
- Custom WebSocket signaling server
- ICE/STUN negotiation

### Social System
- Friend requests
- Private messaging between friends
- Online/offline presence indicators

### Media Support
- Image uploads
- Automatic client-side compression
- Image preview and modal viewer

### Authentication & Security
- Secure password hashing (bcrypt)
- Email verification system
- Password reset flow
- Login rate limiting
- SQL injection protection (parameterized queries)
- XSS mitigation through HTML escaping
- Session token authentication

### Persistence
- PostgreSQL database
- Persistent message history
- Lazy-loaded message pagination
- User profiles and avatars

## Tech Stack

Backend:
- Node.js
- Express
- WebSocket (ws)
- PostgreSQL
- bcrypt
- Nodemailer

Frontend:
- Vanilla JavaScript
- WebRTC
- WebSocket API
- Responsive UI

Infrastructure:
- Environment-based configuration (.env)
- Secure file uploads
- Static asset serving

## Architecture Overview

The system consists of:

- **Node.js WebSocket server** for real-time messaging
- **PostgreSQL database** for persistence
- **WebRTC peer connections** for voice channels
- **Token-based authentication** for session management

WebSocket messages are used for:
- chat messaging
- presence updates
- friend system events
- WebRTC signaling

## Security Considerations

This project implements several defensive measures:

- Password hashing using bcrypt
- SQL injection prevention via parameterized queries
- Login brute-force protection
- HTML escaping to prevent XSS
- Controlled image upload handling
- Token-based authentication

## Purpose

This project was developed as a learning exercise to explore:

- real-time networking
- WebSocket protocol design
- WebRTC signaling
- secure authentication flows
- scalable chat architecture