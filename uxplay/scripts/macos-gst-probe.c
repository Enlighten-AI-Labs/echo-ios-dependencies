/*
 * Validation-only helper (never shipped). Initializes the bundled GStreamer, reports which
 * plugin file provides each required factory and parses pipelines without starting them.
 * Usage: macos-gst-probe <factory>... -- <pipeline>...
 */
#include <gst/gst.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    int failures = 0;
    int i = 1;

    gst_init(NULL, NULL);

    for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
        GstElementFactory *factory = gst_element_factory_find(argv[i]);
        if (!factory) {
            printf("MISSING %s\n", argv[i]);
            failures++;
            continue;
        }
        GstPlugin *plugin = gst_plugin_feature_get_plugin(GST_PLUGIN_FEATURE(factory));
        const gchar *file = plugin ? gst_plugin_get_filename(plugin) : NULL;
        printf("FACTORY %s %s\n", argv[i], file ? file : "(none)");
        if (plugin) gst_object_unref(plugin);
        gst_object_unref(factory);
    }

    for (i++; i < argc; i++) {
        GError *error = NULL;
        GstElement *pipeline = gst_parse_launch(argv[i], &error);
        if (!pipeline || error) {
            printf("PIPELINE_FAIL %s: %s\n", argv[i], error ? error->message : "unknown error");
            failures++;
        } else {
            printf("PIPELINE_OK %s\n", argv[i]);
        }
        if (pipeline) gst_object_unref(pipeline);
        if (error) g_error_free(error);
    }

    GList *plugins = gst_registry_get_plugin_list(gst_registry_get());
    for (GList *item = plugins; item; item = item->next) {
        GstPlugin *plugin = GST_PLUGIN(item->data);
        const gchar *file = gst_plugin_get_filename(plugin);
        printf("PLUGIN %s %s\n", gst_plugin_get_name(plugin), file ? file : "(none)");
    }
    gst_plugin_list_free(plugins);

    return failures == 0 ? 0 : 1;
}
