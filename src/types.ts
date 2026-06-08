export interface AutoDLResponse<T = unknown> {
  code: string;
  data: T;
  msg?: string;
  request_id?: string;
}

export interface AutoDLListData<T> {
  list?: T[];
  page_index?: number;
  page_size?: number;
  page?: number;
  max_page?: number;
}

export interface AutoDLInstance {
  uuid?: string;
  instance_uuid?: string;
  name?: string;
  status?: string;
  gpu_name?: string;
  gpu_alias_name?: string;
  gpu_spec_uuid?: string;
  req_gpu_amount?: number;
  region_name?: string;
  region_sign?: string;
  charge_type?: string;
  payg_price?: number;
  origin_pay_price?: number;
  started_at?: unknown;
  created_at?: unknown;
}

export interface AutoDLSnapshot {
  region_sign?: string;
  payg_price?: number;
  origin_pay_price?: number;
  snapshot_gpu_alias_name?: string;
  chip_corp?: string;
  cpu_arch?: string;
  usage_info?: {
    container_id?: string;
    valid_at?: string;
    cpu_usage_percent?: number;
    mem_usage_percent?: number;
    mem_usage?: number;
    mem_limit?: number;
    root_fs_used_size?: number;
    root_fs_total_size?: number;
    data_disk_total_size?: number;
    data_disk_used_size?: number;
    pull_image_progress?: number;
    download_image_progress?: number;
    valid?: boolean;
  };
  expand_system_disk_size?: number;
  system_init_disk_size?: number;
  ssh_command?: string;
  proxy_host?: string;
  root_password?: string;
  ssh_port?: number;
  jupyter_token?: string;
  jupyter_domain?: string;
  service_6006_domain?: string;
  service_6006_port_protocol?: string;
  service_6008_domain?: string;
  service_6008_port_protocol?: string;
}

export interface QuickCreateDefaults {
  image_uuid: string;
  cuda_min: number;
  gpu_amount: number;
  system_disk: number;
  data_centers?: string[];
  start_command?: string | null;
}

export interface QuickCreateProfile {
  label?: string;
  gpu_spec_uuid: string;
  image_uuid?: string;
  cuda_min?: number;
  gpu_amount?: number;
  system_disk?: number;
  data_centers?: string[];
  name?: string;
  start_command?: string | null;
}

export interface QuickCreateConfig {
  defaults: QuickCreateDefaults;
  profiles: Record<string, QuickCreateProfile>;
}

export interface CreateInstancePayload {
  req_gpu_amount: number;
  expand_system_disk_by_gb: number;
  gpu_spec_uuid: string;
  image_uuid: string;
  cuda_v_from: number;
  data_center_list?: string[];
  instance_name?: string;
  start_command?: string;
}

export interface QuickCreateBuildResult {
  profileName: string;
  label: string;
  payload: CreateInstancePayload;
}
