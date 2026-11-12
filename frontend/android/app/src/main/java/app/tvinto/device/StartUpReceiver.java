package app.tvinto.device;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The device has started: opens the app if it was asked to (StartUp). */
public class StartUpReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            StartUp.open(context);
        }
    }
}
