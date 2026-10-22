-- Removes everything spike-2026-10-22-pos-phase0.sql created. DEV ONLY.
drop function if exists spike_place_table_order(text, jsonb, uuid);
drop function if exists spike_place_counter_order(uuid, jsonb, uuid);
drop function if exists spike_insert_order(uuid, text, uuid, jsonb, uuid);
drop function if exists spike_qr_menu(text);
drop function if exists spike_server_now();
drop function if exists spike_claim_print_job(uuid);
drop function if exists spike_finish_print_job(uuid, boolean, text);
drop function if exists spike_requeue_print_job(uuid);
drop table if exists spike_print_jobs, spike_order_items, spike_orders, spike_bills,
                     spike_print_routes, spike_menu_items, spike_tables cascade;
