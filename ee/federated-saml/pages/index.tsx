import type { NextPage } from 'next';
import type { SAMLFederationApp } from '@boxyhq/saml-jackson';
import useSWR from 'swr';
import { useTranslation } from 'next-i18next';

import type { ApiError, ApiSuccess } from 'types';
import { fetcher } from '@lib/ui/utils';
import Loading from '@components/Loading';
import EmptyState from '@components/EmptyState';
import LicenseRequired from '@components/LicenseRequired';
import { errorToast } from '@components/Toaster';
import { LinkPrimary } from '@components/LinkPrimary';
import { pageLimit, Pagination } from '@components/Pagination';
import usePaginate from '@lib/ui/hooks/usePaginate';
import { LinkOutline } from '@components/LinkOutline';
import { IconButton } from '@components/IconButton';
import PencilIcon from '@heroicons/react/24/outline/PencilIcon';
import PlusIcon from '@heroicons/react/24/outline/PlusIcon';
import router from 'next/router';

const AppsList: NextPage = () => {
  const { t } = useTranslation('common');
  const { paginate, setPaginate } = usePaginate();

  const { data, error } = useSWR<ApiSuccess<SAMLFederationApp[]>, ApiError>(
    `/api/admin/federated-saml?offset=${paginate.offset}&limit=${pageLimit}`,
    fetcher
  );

  if (error) {
    errorToast(error.message);
    return null;
  }

  if (!data) {
    return <Loading />;
  }

  const apps = data.data;
  const noApps = apps && apps.length === 0 && paginate.offset === 0;

  return (
    <LicenseRequired>
      <div className='mb-5 flex items-center justify-between'>
        <h2 className='font-bold text-gray-700 dark:text-white md:text-xl'>{t('saml_federation_apps')}</h2>
        <div className='flex'>
          <LinkPrimary className='m-2' Icon={PlusIcon} href='/admin/federated-saml/new'>
            {t('new_saml_federation_app')}
          </LinkPrimary>
          <LinkOutline href={'/.well-known/idp-configuration'} target='_blank' className='m-2'>
            {t('view_idp_configuration')}
          </LinkOutline>
        </div>
      </div>
      {noApps ? (
        <>
          <EmptyState title={t('no_saml_federation_apps')} href='/admin/federated-saml/new' />
        </>
      ) : (
        <>
          <div className='rounder border'>
            <table className='w-full text-left text-sm text-gray-500 dark:text-gray-400'>
              <thead className='bg-gray-50 text-xs uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-400'>
                <tr className='hover:bg-gray-50'>
                  <th scope='col' className='px-6 py-3'>
                    {t('name')}
                  </th>
                  <th scope='col' className='px-6 py-3'>
                    {t('tenant')}
                  </th>
                  <th scope='col' className='px-6 py-3'>
                    {t('product')}
                  </th>
                  <th scope='col' className='px-6 py-3'>
                    {t('actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {apps &&
                  apps.map((app) => {
                    return (
                      <tr
                        key={app.id}
                        className='border-b bg-white last:border-b-0 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800'>
                        <td className='px-6 py-3'>{app.name}</td>
                        <td className='px-6 py-3'>{app.tenant}</td>
                        <td className='px-6'>{app.product}</td>
                        <td className='px-6'>
                          <span className='inline-flex items-baseline'>
                            <IconButton
                              tooltip={t('edit')}
                              Icon={PencilIcon}
                              className='hover:text-green-400'
                              onClick={() => {
                                router.push(`/admin/federated-saml/${app.id}/edit`);
                              }}
                            />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <Pagination
            itemsCount={apps.length}
            offset={paginate.offset}
            onPrevClick={() => {
              setPaginate({
                offset: paginate.offset - pageLimit,
              });
            }}
            onNextClick={() => {
              setPaginate({
                offset: paginate.offset + pageLimit,
              });
            }}
          />
        </>
      )}
    </LicenseRequired>
  );
};

export default AppsList;