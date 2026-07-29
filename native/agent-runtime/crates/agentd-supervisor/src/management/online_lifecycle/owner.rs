use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;

use super::{OnlineLifecycleShutdown, SupervisorLifecycleClock, SupervisorLifecycleOwner, sealed};
use crate::management::driver::{
    CleanupDriveReport, CleanupStateError, ProtectedLaunchProvisionPort, SupervisorLifecycleCore,
    SupervisorPhysicalDriver,
};

impl<P, V> sealed::Sealed for SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
}

impl<R, W, P, V> sealed::Sealed for SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
}

impl<P, V> SupervisorLifecycleOwner for SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn next_cleanup_deadline_unix_ms(&self) -> Option<i64> {
        self.state().next_cleanup_deadline_unix_ms()
    }

    fn drive_cleanup_tick(
        &mut self,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        self.drive_cleanup_tick_with_clock(clock)
    }

    fn begin_shutdown(
        &mut self,
        shutdown: OnlineLifecycleShutdown,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), CleanupStateError> {
        self.begin_shutdown_with_clock(shutdown, clock)
    }
}

impl<R, W, P, V> SupervisorLifecycleOwner for SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn next_cleanup_deadline_unix_ms(&self) -> Option<i64> {
        self.state().next_cleanup_deadline_unix_ms()
    }

    fn drive_cleanup_tick(
        &mut self,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        self.core.drive_cleanup_tick_with_clock(clock)
    }

    fn begin_shutdown(
        &mut self,
        shutdown: OnlineLifecycleShutdown,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), CleanupStateError> {
        self.core.begin_shutdown_with_clock(shutdown, clock)
    }
}
