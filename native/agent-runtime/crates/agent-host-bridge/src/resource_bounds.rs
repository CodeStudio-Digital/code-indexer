//! Hard Windows Job bounds advertised to the tree admission owner. Keep these
//! shared with the actual launch budgets so reservations cannot undercount.
pub const SUPERVISOR_MEMORY_BYTES: u32 = 512 * 1024 * 1024;
pub const SUPERVISOR_PROCESSES: u32 = 17;
pub const COMMAND_MEMORY_BYTES: u32 = 2 * 1024 * 1024 * 1024;
pub const COMMAND_PROCESSES: u32 = 128;
pub const DUPLEX_MEMORY_BYTES: u32 = 2 * 1024 * 1024 * 1024;
pub const DUPLEX_PROCESSES: u32 = 32;
