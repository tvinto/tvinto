package app.tvinto.storage;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * The idle clean (DatabaseSpace.scheduleWhenIdle): runs DatabaseSpace.clean
 * while the device is idle, and stops it when Android says the device is not.
 */
public class CompactJobService extends JobService {

    private Thread worker;

    @Override
    public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> {
            DatabaseSpace.clean(getApplicationContext(), false);
            jobFinished(params, false);
        }, "database-clean");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        DatabaseSpace.stop();
        // Give the rollback a moment to finish while the job still keeps the
        // process awake; past that it finishes when the app is next opened.
        Thread running = worker;
        if (running != null) {
            try {
                running.join(4000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        return true;
    }
}
