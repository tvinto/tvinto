package app.tvinto;

import android.app.Application;

import app.tvinto.device.ErrorReports;

/**
 * The app's process, however it starts: the launcher, a reminder, a
 * recording, the television turning on. Error reports catch crashes from
 * here on (device/ErrorReports.java).
 */
public class TvintoApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        ErrorReports.onLaunch(this);
    }
}
