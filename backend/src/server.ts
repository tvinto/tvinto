import app from './app';

// The app will automatically start listening when imported
// This file is kept as an entry point for backward compatibility
// and for potential future extensions

export default app.getServer();

// Handle unhandled promise rejections
process.on('unhandledRejection', (err: Error) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  // Close server & exit process
  // For now, we'll keep the process running for development
  // In production, you might want to use a process manager like PM2 to restart the process
  // server.close(() => {
  //   process.exit(1);
  // });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: Error) => {
  console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  // Close server & exit process
  process.exit(1);
});

// Handle SIGTERM signal (e.g., from Docker)
process.on('SIGTERM', () => {
  console.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
  // Close server & exit process
  process.exit(0);
});
